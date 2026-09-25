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

import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { loadActionManifest, runAction } from "./action-runner";
import { ModelUnavailableError, type ChatMessage, type ChatResponse, type ChatTool } from "./chat-model";
import { StepFailure } from "./step-failure";
import { checkToolArgs, toolInput, toolSchema } from "./tool-schema";
import { renderPromptTemplate, type StepRecord, type StepRunnerOptions } from "./step-context";
import type { ActionManifest } from "../types/action";
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

// ---------------------------------------------------------------------------
// Transcript — JSONL into the host's dir, nowhere else
// ---------------------------------------------------------------------------

interface Transcript {
  path?: string;
  /** Queue one JSONL line; lines land in the order they were queued. */
  write: (o: Record<string, unknown>) => void;
  /** Wait for every queued line, then close. Rejects with the first write error. */
  close: () => Promise<void>;
}

const NO_TRANSCRIPT: Transcript = { write: () => {}, close: async () => {} };

async function openTranscript(dir: string | undefined, name: string): Promise<Transcript> {
  if (!dir) return NO_TRANSCRIPT;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to a dir it creates; a reused dir is pinned too.
  await chmod(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `research-${safe}-${stamp}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
  const handle = await open(path, "a", 0o600);
  // open's mode is filtered through the umask; pin it.
  await handle.chmod(0o600);
  // One queue: a FileHandle must not take a second write before the first settles.
  let queue: Promise<void> = Promise.resolve();
  let failed: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  return {
    path,
    write: (o) => {
      // A tool still running when the step timed out may answer after close.
      if (closing) return;
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`;
      queue = queue
        .then(() => (failed ? undefined : handle.appendFile(line)))
        .catch((err) => {
          failed ??= { error: err };
        });
    },
    close: () =>
      (closing ??= queue
        .then(() => handle.close())
        .then(() => {
          if (failed) throw failed.error;
        })),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n[… truncated]`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Settle with `work`, or reject with `onAbort()` as soon as `signal` aborts; `work` is left to finish on its own. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", abort);
        reject(err);
      },
    );
  });
}

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
  let transcript = NO_TRANSCRIPT;
  let manifests = new Map<string, ActionManifest>();
  const seen = new Set<string>();

  let answer: string;
  try {
    answer = await research();
    stats.answer_chars = answer.length;
    transcript.write({ type: "end", ok: true, stats });
    await transcript.close();
  } catch (err) {
    const failure = err instanceof StepFailure ? err : new StepFailure(stepName, errorText(err));
    transcript.write({ type: "end", ok: false, error: failure.causeError });
    try {
      await transcript.close();
    } catch (_err) {
      // The step has already failed; a transcript that could not be written
      // must not replace that error.
    }
    options.onResearchEvent?.({
      type: "research.failed",
      name: spec.name,
      error: failure.causeError,
      unavailable: failure instanceof ResearchUnavailable,
    });
    stepRecords.push({ action: stepName, success: false, durationMs: Date.now() - stepStart, error: failure.causeError, research: stats });
    throw failure;
  }

  options.onResearchEvent?.({ type: "research.completed", name: spec.name, stats });
  stepRecords.push({ action: stepName, success: true, durationMs: Date.now() - stepStart, research: stats });
  return { ...payload, [spec.collect ?? `research_${spec.name}`]: answer };

  /** Set up, run the loop, return the model's answer. Throws on any failure. */
  async function research(): Promise<string> {
    const model = options.models?.[spec.model];
    if (!model) throw new StepFailure(stepName, `no model '${spec.model}' in StepRunnerOptions.models`);

    // runPipeline's preflight already checked this step's tools; driven any
    // other way, the step checks them itself.
    manifests = options.researchTools?.get(spec) ?? (await checkResearchTools(spec, options.actionDirs));

    const prompt = renderPromptTemplate(spec.prompt, payload);
    const system = spec.system ? renderPromptTemplate(spec.system, payload) : undefined;

    try {
      transcript = await openTranscript(options.transcriptDir, spec.name);
    } catch (err) {
      throw new StepFailure(stepName, `transcript dir: ${errorText(err)}`);
    }
    stats.transcript = transcript.path;

    const tools: ChatTool[] = spec.tools.map((name) => {
      const manifest = manifests.get(name)!;
      return {
        type: "function",
        function: { name, description: manifest.description ?? "", parameters: { ...toolSchema(manifest, bind) } },
      };
    });

    // The runner owns the timeout: it reaches the model call and every tool
    // run, and a round ends the moment it fires.
    const controller = new AbortController();
    const timer = spec.timeout_ms ? setTimeout(() => controller.abort(), spec.timeout_ms) : null;
    const onParentAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const aborted = () => new StepFailure(stepName, spec.timeout_ms ? `timeout after ${spec.timeout_ms}ms` : "aborted");

    const messages: ChatMessage[] = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      { role: "user", content: prompt },
    ];
    let writing = false;

    transcript.write({ type: "start", step: spec.name, model: model.label, tools: spec.tools, bind: Object.keys(bind) });
    options.onResearchEvent?.({ type: "research.started", name: spec.name, model: spec.model, tools: spec.tools });

    try {
      while (true) {
        if (controller.signal.aborted) throw aborted();
        if (!writing && stats.rounds >= maxRounds) {
          writing = true;
          messages.push({ role: "user", content: writePrompt });
        }
        stats.rounds++;
        let res: ChatResponse;
        try {
          res = await raceAbort(
            model.complete(
              { messages, tools: writing ? undefined : tools, maxTokens: spec.max_tokens, temperature: spec.temperature },
              { signal: controller.signal },
            ),
            controller.signal,
            aborted,
          );
        } catch (err) {
          if (err instanceof ModelUnavailableError) throw new ResearchUnavailable(stepName, err.reason);
          if (controller.signal.aborted) throw aborted();
          throw err;
        }
        stats.tokens_in += res.usage?.input ?? 0;
        stats.tokens_out += res.usage?.output ?? 0;
        transcript.write({
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
          // Calls are screened in the model's order (that decides which of two
          // identical calls is the duplicate), then run concurrently; results
          // go back in the model's order.
          const calls = res.toolCalls.map((call) => callTool(call.function.name, call.function.arguments));
          const results = await raceAbort(Promise.all(calls), controller.signal, aborted);
          res.toolCalls.forEach((call, i) => {
            messages.push({ role: "tool", tool_call_id: call.id, content: clip(results[i], resultChars) });
          });
          options.onResearchEvent?.({
            type: "research.round",
            name: spec.name,
            round: stats.rounds,
            tool_calls: res.toolCalls.map((c) => c.function.name),
          });
          continue;
        }

        const content = res.content ?? "";
        if (content.trim() === "" && stats.empty_retries < emptyRetries) {
          stats.empty_retries++;
          writing = true;
          // Keep strict user/assistant alternation for chat templates that demand it.
          messages.push({ role: "assistant", content }, { role: "user", content: writePrompt });
          continue;
        }
        if (content.trim() === "") {
          throw new StepFailure(stepName, `empty answer after ${stats.empty_retries} retries`);
        }
        return content;
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  /**
   * One tool call → the text the model sees. Never rejects. Screening
   * (unknown tool, duplicate, bad arguments) runs synchronously, before this
   * returns, so the order of calls decides duplicates.
   */
  function callTool(name: string, rawArgs: string): Promise<string> {
    const round = stats.rounds;
    const reply = (result: string, extra: Record<string, unknown> = {}): string => {
      transcript.write({ type: "tool", round, tool: name, args: rawArgs, result, ...extra });
      return result;
    };

    const manifest = manifests.get(name);
    if (!manifest) return Promise.resolve(reply(`unknown tool ${name}`));
    const sig = `${name}:${rawArgs}`;
    if (seen.has(sig)) {
      stats.duplicates++;
      return Promise.resolve(reply("(duplicate call; see the earlier result)", { duplicate: true }));
    }
    seen.add(sig);
    stats.tool_calls[name] = (stats.tool_calls[name] ?? 0) + 1;

    let args: unknown;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (_err) {
      // The model's arguments are data; a parse failure is reported back to it.
      return Promise.resolve(reply("tool error: arguments are not valid JSON"));
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return Promise.resolve(reply("tool error: arguments must be a JSON object"));
    }
    const invalid = checkToolArgs(manifest, args as Record<string, unknown>, bind);
    if (invalid) return Promise.resolve(reply(`tool error: ${invalid}`));

    const input = toolInput(manifest, args as Record<string, unknown>, bind);
    // An action takes no signal; the step's timeout ends the round around it (raceAbort).
    return runAction(name, input, { ...options, shellArgvOnly: true, traceId: crypto.randomUUID() }).then(
      (run) =>
        reply(run.success ? resultText(manifest, run.output) : `tool error: ${run.error ?? "unknown error"}`, {
          input,
          ok: run.success,
        }),
      (err) => reply(`tool error: ${errorText(err)}`, { input, ok: false }),
    );
  }
}
