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
import { resolveAction, runAction, type ResolvedAction } from "./action-runner";
import { ModelError, ModelUnavailableError, type ChatMessage, type ChatModel, type ChatResponse, type ChatTool } from "./chat-model";
import { mapWithConcurrency } from "./concurrency";
import { StepFailure } from "./step-failure";
import { checkToolArgs, toolInput, toolSchema } from "./tool-schema";
import { renderPromptTemplate, runState, type StepRecord, type StepRunnerOptions } from "./step-options";
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
  const optional = (field: string, ok: (v: unknown) => boolean, what: string) => {
    if (spec[field] !== undefined && !ok(spec[field])) throw new Error(`${path}: '${field}' must be ${what} when set`);
  };
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  for (const field of ["max_rounds", "result_chars", "max_tokens", "timeout_ms"]) {
    optional(field, (v) => isInt(v) && v > 0, "a positive integer");
  }
  optional("empty_retries", (v) => isInt(v) && v >= 0, "a non-negative integer");
  for (const field of ["system", "write_prompt", "collect"]) {
    optional(field, (v) => typeof v === "string" && v.length > 0, "a non-empty string");
  }
  optional("temperature", (v) => typeof v === "number", "a number");
}

/**
 * Resolve every tool and refuse what a model must never reach: a missing
 * action, an action not declared `effect: read`, and a bind key that no tool
 * declares (a typo there would silently unpin a field). The step runs each
 * tool from what this returns, so the manifest checked is the one executed.
 */
export async function checkResearchTools(
  spec: ResearchStepSpec,
  actionDirs: string[],
): Promise<Map<string, ResolvedAction>> {
  const tools = new Map<string, ResolvedAction>();
  for (const tool of spec.tools) {
    const resolved = await resolveAction(tool, actionDirs);
    if (!resolved) {
      throw new Error(`research ${spec.name}: tool ${tool} not found`);
    }
    if (resolved.manifest.effect !== "read") {
      throw new Error(
        `research ${spec.name}: tool ${tool} is effect ${resolved.manifest.effect ?? "undeclared"}; a research step offers a model read actions only`,
      );
    }
    tools.set(tool, resolved);
  }
  for (const field of Object.keys(spec.bind ?? {})) {
    const declared = [...tools.values()].some((t) => field in (t.manifest.input ?? {}));
    if (!declared) {
      throw new Error(`research ${spec.name}: bind field '${field}' is declared by none of its tools`);
    }
  }
  return tools;
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

/** Tool runs in flight at once within one round; the model may ask for more. */
const TOOL_CONCURRENCY = 4;

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

/** One tool call after screening: either the text the model gets, or the input to run. */
type ScreenedCall = { reply: string; extra?: Record<string, unknown> } | { tool: ResolvedAction; input: Record<string, unknown> };

/** One research step's run: its settings, its state, and the loop. */
class ResearchRun {
  readonly stepName: string;
  readonly stats: ResearchStats;
  transcript: Transcript = NO_TRANSCRIPT;
  private readonly bind: Record<string, unknown>;
  private readonly maxRounds: number;
  private readonly emptyRetries: number;
  private readonly resultChars: number;
  private readonly writePrompt: string;
  private readonly controller = new AbortController();
  private resolved = new Map<string, ResolvedAction>();
  private readonly seen = new Set<string>();
  private readonly messages: ChatMessage[] = [];
  private tools: ChatTool[] = [];
  private writing = false;
  private timedOut = false;

  constructor(
    private readonly spec: ResearchStepSpec,
    private readonly payload: Record<string, unknown>,
    private readonly options: StepRunnerOptions,
  ) {
    this.stepName = `research:${spec.name}`;
    this.bind = spec.bind ?? {};
    this.maxRounds = spec.max_rounds ?? DEFAULT_MAX_ROUNDS;
    this.emptyRetries = spec.empty_retries ?? DEFAULT_EMPTY_RETRIES;
    this.resultChars = spec.result_chars ?? DEFAULT_RESULT_CHARS;
    this.writePrompt = spec.write_prompt ?? DEFAULT_WRITE_PROMPT;
    this.stats = {
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
  }

  /** Set up, loop until the model answers, return the answer. Throws on any failure. */
  async run(): Promise<string> {
    const { spec, options } = this;
    const model = options.models?.[spec.model];
    if (!model) throw new StepFailure(this.stepName, `no model '${spec.model}' in StepRunnerOptions.models`);
    const state = runState(options);
    // Once a model gave no answer at all in this run (no key, network failure,
    // timeout), later steps on it (the rest of a map) fail at once instead of
    // each waiting out a timeout. A 429 or 5xx is an answer and marks nothing.
    const down = state?.unavailableModels.get(spec.model);
    if (down !== undefined) throw new ResearchUnavailable(this.stepName, `${down} (earlier in this run)`);

    // runPipeline's preflight already checked this step's tools; driven any
    // other way, the step checks them itself.
    this.resolved =
      (state?.preflight.get(spec) as Map<string, ResolvedAction> | undefined) ??
      (await checkResearchTools(spec, options.actionDirs));

    const prompt = renderPromptTemplate(spec.prompt, this.payload);
    const system = spec.system ? renderPromptTemplate(spec.system, this.payload) : undefined;
    if (system) this.messages.push({ role: "system", content: system });
    this.messages.push({ role: "user", content: prompt });

    try {
      this.transcript = await openTranscript(options.transcriptDir, spec.name);
    } catch (err) {
      throw new StepFailure(this.stepName, `transcript dir: ${errorText(err)}`);
    }
    this.stats.transcript = this.transcript.path;

    this.tools = spec.tools.map((name) => {
      const { manifest } = this.resolved.get(name)!;
      return {
        type: "function",
        function: { name, description: manifest.description ?? "", parameters: { ...toolSchema(manifest, this.bind) } },
      };
    });

    // The runner owns the timeout: it reaches the model call and every tool
    // run, and a round ends the moment it fires.
    const timer = spec.timeout_ms
      ? setTimeout(() => {
          this.timedOut = true;
          this.controller.abort();
        }, spec.timeout_ms)
      : null;
    const onParentAbort = () => this.controller.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (options.signal?.aborted) this.controller.abort();

    this.transcript.write({ type: "start", step: spec.name, model: model.label, tools: spec.tools, bind: Object.keys(this.bind) });
    options.onResearchEvent?.({ type: "research.started", name: spec.name, model: spec.model, tools: spec.tools });

    try {
      while (true) {
        const answer = await this.round(model);
        if (answer !== undefined) return answer;
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  private aborted = (): StepFailure =>
    new StepFailure(this.stepName, this.timedOut ? `timeout after ${this.spec.timeout_ms}ms` : "aborted");

  /** One model call and whatever it asks for. Returns the answer once there is one. */
  private async round(model: ChatModel): Promise<string | undefined> {
    const { signal } = this.controller;
    if (signal.aborted) throw this.aborted();
    if (!this.writing && this.stats.rounds >= this.maxRounds) {
      this.writing = true;
      this.messages.push({ role: "user", content: this.writePrompt });
    }
    this.stats.rounds++;

    const res = await this.complete(model);
    this.stats.tokens_in += res.usage?.input ?? 0;
    this.stats.tokens_out += res.usage?.output ?? 0;
    this.transcript.write({
      type: "model",
      round: this.stats.rounds,
      writing: this.writing,
      finish: res.finishReason,
      content: res.content,
      reasoning: res.reasoning,
      tool_calls: res.toolCalls.map((c) => ({ name: c.function.name, args: c.function.arguments })),
      usage: res.usage,
    });

    if (!this.writing && res.toolCalls.length > 0) {
      this.messages.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
      // Screening runs in the model's order (it decides which of two identical
      // calls is the duplicate); the real runs then go at most
      // TOOL_CONCURRENCY at a time, and results go back in the model's order.
      const screened = res.toolCalls.map((call) => this.screen(call.function.name, call.function.arguments));
      const results = await raceAbort(
        mapWithConcurrency(screened, (s, i) => this.execute(res.toolCalls[i].function, s), TOOL_CONCURRENCY),
        signal,
        this.aborted,
      );
      res.toolCalls.forEach((call, i) => {
        this.messages.push({ role: "tool", tool_call_id: call.id, content: clip(results[i], this.resultChars) });
      });
      this.options.onResearchEvent?.({
        type: "research.round",
        name: this.spec.name,
        round: this.stats.rounds,
        tool_calls: res.toolCalls.map((c) => c.function.name),
      });
      return undefined;
    }

    const content = res.content ?? "";
    if (content.trim() !== "") return content;
    if (this.stats.empty_retries >= this.emptyRetries) {
      throw new StepFailure(this.stepName, `empty answer after ${this.stats.empty_retries} retries`);
    }
    this.stats.empty_retries++;
    this.writing = true;
    // Keep strict user/assistant alternation for chat templates that demand it.
    this.messages.push({ role: "assistant", content }, { role: "user", content: this.writePrompt });
    return undefined;
  }

  /** The model call. What the gateway said on an error goes to the transcript, never into the step's error. */
  private async complete(model: ChatModel): Promise<ChatResponse> {
    const { signal } = this.controller;
    try {
      return await raceAbort(
        model.complete(
          {
            messages: this.messages,
            tools: this.writing ? undefined : this.tools,
            maxTokens: this.spec.max_tokens,
            temperature: this.spec.temperature,
          },
          { signal },
        ),
        signal,
        this.aborted,
      );
    } catch (err) {
      if (signal.aborted) throw this.aborted();
      if (err instanceof ModelUnavailableError || err instanceof ModelError) {
        this.transcript.write({ type: "model_error", round: this.stats.rounds, error: err.message, detail: err.detail });
      }
      if (err instanceof ModelUnavailableError) {
        if (err.unreachable) runState(this.options)?.unavailableModels.set(this.spec.model, err.reason);
        throw new ResearchUnavailable(this.stepName, err.reason);
      }
      throw err;
    }
  }

  /**
   * Decide a tool call without running it: unknown tool, duplicate, bad
   * arguments are answered here; anything else comes back as the input to run.
   */
  private screen(name: string, rawArgs: string): ScreenedCall {
    const tool = this.resolved.get(name);
    if (!tool) return { reply: `unknown tool ${name}` };
    const sig = `${name}:${rawArgs}`;
    if (this.seen.has(sig)) {
      this.stats.duplicates++;
      return { reply: "(duplicate call; see the earlier result)", extra: { duplicate: true } };
    }
    this.seen.add(sig);
    this.stats.tool_calls[name] = (this.stats.tool_calls[name] ?? 0) + 1;

    let args: unknown;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (_err) {
      // The model's arguments are data; a parse failure is reported back to it.
      return { reply: "tool error: arguments are not valid JSON" };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { reply: "tool error: arguments must be a JSON object" };
    }
    const invalid = checkToolArgs(tool.manifest, args as Record<string, unknown>, this.bind);
    if (invalid) return { reply: `tool error: ${invalid}` };
    return { tool, input: toolInput(tool.manifest, args as Record<string, unknown>, this.bind) };
  }

  /** Run a screened call (unless the step has ended) and return the text the model sees. Never rejects. */
  private async execute(fn: { name: string; arguments: string }, call: ScreenedCall): Promise<string> {
    const round = this.stats.rounds;
    const reply = (result: string, extra: Record<string, unknown> = {}): string => {
      this.transcript.write({ type: "tool", round, tool: fn.name, args: fn.arguments, result, ...extra });
      return result;
    };
    if ("reply" in call) return reply(call.reply, call.extra);
    // A call still queued when the step times out never starts.
    if (this.controller.signal.aborted) return "tool error: the step ended before this call ran";
    try {
      // The step's signal kills the action's shell children and aborts its
      // fetches; raceAbort ends the round even if the action ignores it.
      const run = await runAction(fn.name, call.input, {
        ...this.options,
        signal: this.controller.signal,
        resolved: call.tool,
        shellArgvOnly: true,
        traceId: crypto.randomUUID(),
      });
      const text = run.success ? resultText(call.tool.manifest, run.output) : `tool error: ${run.error ?? "unknown error"}`;
      return reply(text, { input: call.input, ok: run.success });
    } catch (err) {
      return reply(`tool error: ${errorText(err)}`, { input: call.input, ok: false });
    }
  }
}

export async function runResearch(
  spec: ResearchStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const stepStart = Date.now();
  const run = new ResearchRun(spec, payload, options);
  let answer: string;
  try {
    answer = await run.run();
    run.stats.answer_chars = answer.length;
    run.transcript.write({ type: "end", ok: true, stats: run.stats });
    await run.transcript.close();
  } catch (err) {
    const failure = err instanceof StepFailure ? err : new StepFailure(run.stepName, errorText(err));
    run.transcript.write({ type: "end", ok: false, error: failure.causeError });
    try {
      await run.transcript.close();
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
    stepRecords.push({ action: run.stepName, success: false, durationMs: Date.now() - stepStart, error: failure.causeError, research: run.stats });
    throw failure;
  }

  options.onResearchEvent?.({ type: "research.completed", name: spec.name, stats: run.stats });
  stepRecords.push({ action: run.stepName, success: true, durationMs: Date.now() - stepStart, research: run.stats });
  return { ...payload, [spec.collect ?? `research_${spec.name}`]: answer };
}
