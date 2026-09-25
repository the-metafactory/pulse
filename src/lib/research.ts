/**
 * Research primitive — a chat model researches through read-only actions.
 *
 * The loop (one model call per round):
 *   1. offer the model the step's tools; run every tool call it makes and
 *      hand the results back; repeat up to `max_rounds`
 *   2. when the model answers without calling a tool, or the rounds run out,
 *      that answer is the result — the last turn goes out with NO tools
 *      field at all (some gateways answer `tool_choice: "none"` empty)
 *   3. an empty answer earns up to `empty_retries` more write turns
 *
 * Duplicate calls (same tool, same arguments) get a pointer to the earlier
 * result instead of a second run. Guards and threat model: src/types/research.ts.
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadActionManifest, runAction } from "./action-runner";
import { ModelUnavailableError, type ChatMessage, type ChatTool } from "./chat-model";
import { StepFailure } from "./step-failure";
import { toolInput, toolSchema } from "./tool-schema";
import { renderPromptTemplate, type StepRecord, type StepRunnerOptions } from "./primitive-runner";
import type { ActionManifest } from "../types/action";
import type { PipelineStep } from "../types/pipeline";
import type { ResearchStats, ResearchStepSpec } from "../types/research";

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_EMPTY_RETRIES = 2;
const DEFAULT_RESULT_CHARS = 4000;
const DEFAULT_WRITE_PROMPT = "Research is over. Write your answer now, from what the tools returned.";
/** OpenAI function names: letters, digits, underscore, dash; 64 chars max. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The research model could not be reached; a host that queues work retries it later. */
export class ResearchUnavailable extends StepFailure {
  constructor(
    step: string,
    public readonly reason: string,
  ) {
    super(step, `model unavailable: ${reason}`);
    this.name = "ResearchUnavailable";
  }
}

// ---------------------------------------------------------------------------
// Validation — shape at parse time, tool manifests before the run
// ---------------------------------------------------------------------------

export function validateResearch(spec: Record<string, unknown>, path: string): void {
  for (const field of ["name", "model", "prompt"] as const) {
    if (typeof spec[field] !== "string" || (spec[field] as string).length === 0) {
      throw new Error(`${path}: '${field}' must be a non-empty string`);
    }
  }
  if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
    throw new Error(`${path}: 'tools' must be a non-empty array of action names`);
  }
  for (const tool of spec.tools) {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool)) {
      throw new Error(`${path}: tool '${String(tool)}' is not a valid action name for a model tool`);
    }
  }
  if (new Set(spec.tools).size !== spec.tools.length) {
    throw new Error(`${path}: duplicate tools detected`);
  }
  if ("bind" in spec && spec.bind !== undefined) {
    if (spec.bind === null || typeof spec.bind !== "object" || Array.isArray(spec.bind)) {
      throw new Error(`${path}: 'bind' must be an object of field → value`);
    }
  }
  for (const field of ["max_rounds", "result_chars", "max_tokens", "timeout_ms"] as const) {
    if (field in spec && spec[field] !== undefined) {
      const v = spec[field];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new Error(`${path}: '${field}' must be a positive integer when set`);
      }
    }
  }
  if ("empty_retries" in spec && spec.empty_retries !== undefined) {
    const v = spec.empty_retries;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`${path}: 'empty_retries' must be a non-negative integer when set`);
    }
  }
  for (const field of ["system", "write_prompt", "collect"] as const) {
    if (field in spec && spec[field] !== undefined && (typeof spec[field] !== "string" || (spec[field] as string).length === 0)) {
      throw new Error(`${path}: '${field}' must be a non-empty string when set`);
    }
  }
  if ("temperature" in spec && spec.temperature !== undefined && typeof spec.temperature !== "number") {
    throw new Error(`${path}: 'temperature' must be a number when set`);
  }
}

/**
 * Load every tool's manifest and refuse what a model must never reach: a
 * missing action, an action not declared `effect: read`, and a bind key that
 * no tool declares (a typo there would silently unpin a field).
 */
export async function checkResearchTools(
  spec: ResearchStepSpec,
  actionDirs: string[],
): Promise<Map<string, ActionManifest>> {
  const manifests = new Map<string, ActionManifest>();
  for (const tool of spec.tools) {
    const manifest = await loadActionManifest(tool, actionDirs);
    if (!manifest) {
      throw new Error(`research ${spec.name}: tool ${tool} not found`);
    }
    if (manifest.effect !== "read") {
      throw new Error(
        `research ${spec.name}: tool ${tool} is effect ${manifest.effect ?? "undeclared"}; a research step offers a model read actions only`,
      );
    }
    manifests.set(tool, manifest);
  }
  for (const field of Object.keys(spec.bind ?? {})) {
    const declared = [...manifests.values()].some((m) => field in (m.input ?? {}));
    if (!declared) {
      throw new Error(`research ${spec.name}: bind field '${field}' is declared by none of its tools`);
    }
  }
  return manifests;
}

/**
 * Pipeline preflight: check the tools of every research step, nested ones
 * included, before the first step runs. A pipeline that would offer a model
 * a write action never starts.
 */
export async function preflightSteps(steps: PipelineStep[], actionDirs: string[]): Promise<void> {
  for (const step of steps) {
    if (typeof step === "string" || step === null || typeof step !== "object") continue;
    const s = step as Record<string, any>;
    if (s.research) await checkResearchTools(s.research as ResearchStepSpec, actionDirs);
    for (const key of ["map", "filter", "reduce", "retry"]) {
      if (Array.isArray(s[key]?.actions)) await preflightSteps(s[key].actions, actionDirs);
    }
    if (s.parallel?.branches && typeof s.parallel.branches === "object") {
      for (const branch of Object.values(s.parallel.branches as Record<string, any>)) {
        if (Array.isArray(branch?.actions)) await preflightSteps(branch.actions, actionDirs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Trace — JSONL into the host's dir, nowhere else
// ---------------------------------------------------------------------------

function openTrace(dir: string | undefined, name: string): { path?: string; write: (o: Record<string, unknown>) => void } {
  if (!dir) return { write: () => {} };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `research-${safe}-${stamp}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
  let created = false;
  return {
    path,
    write: (o) => {
      appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`, { mode: 0o600 });
      if (!created) {
        // appendFileSync's mode applies on creation only under the umask; pin it.
        chmodSync(path, 0o600);
        created = true;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n[… truncated]`);

/** What the model sees of an action's output: its declared output fields. */
function resultText(manifest: ActionManifest, output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return String(output ?? "");
  const declared = Object.keys(manifest.output ?? {});
  const out = output as Record<string, unknown>;
  const fields = declared.length > 0 ? declared.filter((f) => f in out) : Object.keys(out);
  if (fields.length === 1 && typeof out[fields[0]] === "string") return out[fields[0]] as string;
  return JSON.stringify(Object.fromEntries(fields.map((f) => [f, out[f]])));
}

export async function runResearch(
  spec: ResearchStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const stepName = `research:${spec.name}`;
  const stepStart = Date.now();
  const bind = spec.bind ?? {};
  const maxRounds = spec.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const emptyRetries = spec.empty_retries ?? DEFAULT_EMPTY_RETRIES;
  const resultChars = spec.result_chars ?? DEFAULT_RESULT_CHARS;
  const writePrompt = spec.write_prompt ?? DEFAULT_WRITE_PROMPT;
  const stats: ResearchStats = {
    name: spec.name,
    model: spec.model,
    rounds: 0,
    tool_calls: {},
    duplicates: 0,
    empty_retries: 0,
    tokens_in: 0,
    tokens_out: 0,
    answer_chars: 0,
  };
  let trace: ReturnType<typeof openTrace> = { write: () => {} };

  const fail = (err: StepFailure, unavailable: boolean): never => {
    trace.write({ type: "end", ok: false, error: err.causeError });
    options.onResearchEvent?.({ type: "research.failed", name: spec.name, error: err.causeError, unavailable });
    stepRecords.push({ action: stepName, success: false, durationMs: Date.now() - stepStart, error: err.causeError, research: stats });
    throw err;
  };

  const model = options.models?.[spec.model];
  if (!model) {
    return fail(new StepFailure(stepName, `no model '${spec.model}' in StepRunnerOptions.models`), false);
  }

  let manifests: Map<string, ActionManifest>;
  try {
    manifests = await checkResearchTools(spec, options.actionDirs);
  } catch (err) {
    return fail(new StepFailure(stepName, err instanceof Error ? err.message : String(err)), false);
  }

  let prompt: string;
  let system: string | undefined;
  try {
    prompt = renderPromptTemplate(spec.prompt, payload);
    system = spec.system ? renderPromptTemplate(spec.system, payload) : undefined;
  } catch (err) {
    return fail(new StepFailure(stepName, err instanceof Error ? err.message : String(err)), false);
  }

  try {
    trace = openTrace(options.traceDir, spec.name);
  } catch (err) {
    return fail(new StepFailure(stepName, `trace dir: ${err instanceof Error ? err.message : String(err)}`), false);
  }
  stats.trace = trace.path;

  const tools: ChatTool[] = spec.tools.map((name) => {
    const manifest = manifests.get(name)!;
    return {
      type: "function",
      function: { name, description: manifest.description ?? "", parameters: { ...toolSchema(manifest, bind) } },
    };
  });

  // Runner owns the timeout; the model sees one AbortSignal (agent precedent).
  const controller = new AbortController();
  const timer = spec.timeout_ms ? setTimeout(() => controller.abort(), spec.timeout_ms) : null;
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  };

  const messages: ChatMessage[] = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    { role: "user", content: prompt },
  ];
  const seen = new Set<string>();
  let writing = false;
  let answer = "";

  trace.write({ type: "start", step: spec.name, model: model.label, tools: spec.tools, bind: Object.keys(bind) });
  options.onResearchEvent?.({ type: "research.started", name: spec.name, model: spec.model, tools: spec.tools });

  try {
    while (true) {
      if (controller.signal.aborted) {
        throw new StepFailure(stepName, spec.timeout_ms ? `timeout after ${spec.timeout_ms}ms` : "aborted");
      }
      if (!writing && stats.rounds >= maxRounds) {
        writing = true;
        messages.push({ role: "user", content: writePrompt });
      }
      stats.rounds++;
      let res;
      try {
        res = await model.complete(
          { messages, tools: writing ? undefined : tools, maxTokens: spec.max_tokens, temperature: spec.temperature },
          { signal: controller.signal },
        );
      } catch (err) {
        if (err instanceof ModelUnavailableError) throw new ResearchUnavailable(stepName, err.reason);
        if (controller.signal.aborted) {
          throw new StepFailure(stepName, spec.timeout_ms ? `timeout after ${spec.timeout_ms}ms` : "aborted");
        }
        throw new StepFailure(stepName, err instanceof Error ? err.message : String(err));
      }
      stats.tokens_in += res.usage?.input ?? 0;
      stats.tokens_out += res.usage?.output ?? 0;
      trace.write({
        type: "model",
        round: stats.rounds,
        writing,
        finish: res.finishReason,
        content: res.content,
        reasoning: res.reasoning,
        tool_calls: res.toolCalls.map((c) => ({ name: c.function.name, args: c.function.arguments })),
        usage: res.usage,
      });

      if (!writing && res.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
        const names: string[] = [];
        for (const call of res.toolCalls) {
          const name = call.function.name;
          const result = await runTool(name, call.function.arguments);
          names.push(name);
          messages.push({ role: "tool", tool_call_id: call.id, content: clip(result, resultChars) });
        }
        options.onResearchEvent?.({ type: "research.round", name: spec.name, round: stats.rounds, tool_calls: names });
        continue;
      }

      answer = res.content ?? "";
      if (answer.trim() === "" && stats.empty_retries < emptyRetries) {
        stats.empty_retries++;
        writing = true;
        messages.push({ role: "user", content: writePrompt });
        continue;
      }
      break;
    }
  } catch (err) {
    cleanup();
    const failure = err instanceof StepFailure ? err : new StepFailure(stepName, err instanceof Error ? err.message : String(err));
    return fail(failure, failure instanceof ResearchUnavailable);
  }
  cleanup();

  if (answer.trim() === "") {
    return fail(new StepFailure(stepName, `empty answer after ${stats.empty_retries} retries`), false);
  }

  stats.answer_chars = answer.length;
  trace.write({ type: "end", ok: true, stats });
  options.onResearchEvent?.({ type: "research.completed", name: spec.name, stats });
  stepRecords.push({ action: stepName, success: true, durationMs: Date.now() - stepStart, research: stats });
  return { ...payload, [spec.collect ?? `research_${spec.name}`]: answer };

  /** Run one tool call and return the text the model sees. Never throws. */
  async function runTool(name: string, rawArgs: string): Promise<string> {
    const round = stats.rounds;
    const sig = `${name}:${rawArgs}`;
    const manifest = manifests.get(name);
    if (!manifest) {
      const result = `unknown tool ${name}`;
      trace.write({ type: "tool", round, tool: name, args: rawArgs, result });
      return result;
    }
    if (seen.has(sig)) {
      stats.duplicates++;
      const result = "(duplicate call; see the earlier result)";
      trace.write({ type: "tool", round, tool: name, args: rawArgs, result, duplicate: true });
      return result;
    }
    seen.add(sig);
    stats.tool_calls[name] = (stats.tool_calls[name] ?? 0) + 1;

    let args: unknown;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (_err) {
      // The model's arguments are data; a parse failure is reported back to it.
      const result = "tool error: arguments are not valid JSON";
      trace.write({ type: "tool", round, tool: name, args: rawArgs, result });
      return result;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      const result = "tool error: arguments must be a JSON object";
      trace.write({ type: "tool", round, tool: name, args: rawArgs, result });
      return result;
    }

    const input = toolInput(manifest, args as Record<string, unknown>, bind);
    const run = await runAction(name, input, {
      ...options,
      shellArgvOnly: true,
      traceId: crypto.randomUUID(),
    });
    const result = run.success ? resultText(manifest, run.output) : `tool error: ${run.error ?? "unknown error"}`;
    trace.write({ type: "tool", round, tool: name, args: rawArgs, input, result, ok: run.success });
    return result;
  }
}
