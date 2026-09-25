import type { ActionRunnerOptions } from "./action-runner";
import { StdinGateProvider } from "./gate-provider";
import type {
  PipelineStep,
  MapStepSpec,
  FilterStepSpec,
  ReduceStepSpec,
  ParallelStepSpec,
  RetryStepSpec,
  GateStepSpec,
  GateProvider,
  GateEvent,
  GateResult,
  AgentStepSpec,
  AgentEvent,
  AgentTaskResult,
  ActionStepEvent,
} from "../types/pipeline";
import type {
  SeatSpec,
  SeatVote,
  TribunalEvent,
  TribunalRuling,
  TribunalStepSpec,
  TribunalVerdict,
} from "../types/tribunal";
import {
  VOTE_FORMAT_INSTRUCTION,
  abstainVote,
  aggregate,
  applyDiversityDowngrade,
  checkPosthocDiversity,
  parseSeatVote,
  planDiversity,
} from "./tribunal";
import { evaluate } from "./enforcement-gate";
import type { GovernedEvent, GovernedResult, GovernedStepSpec } from "../types/governed";

import { StepFailure, MapItemFailure } from "./step-failure";
import { runResearch, validateResearch } from "./research";
import type { ChatModel } from "./chat-model";
import type { ResearchEvent, ResearchStats, ResearchStepSpec } from "../types/research";

export { StepFailure, MapItemFailure };

export interface StepRecord {
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
  /** Populated for gate steps — full GateResult so downstream traces can audit verdict + notes. */
  gate?: GateResult;
  /** Populated for tribunal steps — full TribunalVerdict (votes, diversity, tiebreak). */
  tribunal?: TribunalVerdict;
  /** Populated for governed steps — full GovernedResult (l0 + tribunal + gate verdicts). */
  governed?: GovernedResult;
  /** Populated for research steps — rounds, tool calls, tokens, trace path. */
  research?: ResearchStats;
}

/** Options threaded through the step runner, extending ActionRunnerOptions */
export interface StepRunnerOptions extends ActionRunnerOptions {
  mode?: "local" | "cloud";
  /** AbortSignal for cooperative cancellation (used by parallel branches) */
  signal?: AbortSignal;
  /** Gate input source. Defaults to StdinGateProvider when omitted. */
  gateProvider?: GateProvider;
  /** Optional sink for plain-action step lifecycle events. Hosts can pipe to traces, dashboards, chat threads, etc. */
  onActionStepEvent?: (event: ActionStepEvent) => void;
  /** Optional sink for gate lifecycle events. Hosts can pipe to traces, dashboards, etc. */
  onGateEvent?: (event: GateEvent) => void;
  /** Optional sink for agent lifecycle events. */
  onAgentEvent?: (event: AgentEvent) => void;
  /** Optional sink for tribunal lifecycle events. */
  onTribunalEvent?: (event: TribunalEvent) => void;
  /** Optional sink for governed-action lifecycle events. */
  onGovernedEvent?: (event: GovernedEvent) => void;
  /** Chat models a research step may name, keyed by the name pipelines use. */
  models?: Record<string, ChatModel>;
  /**
   * Directory for research JSONL traces (tool calls, arguments, results).
   * Absent → no trace is written. Created 0700, files 0600.
   */
  traceDir?: string;
  /** Optional sink for research lifecycle events (names and counts only). */
  onResearchEvent?: (event: ResearchEvent) => void;
}

type ValidateStep = (step: unknown, path?: string) => PipelineStep;
type RunSteps = (
  steps: PipelineStep[],
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
) => Promise<Record<string, unknown>>;

interface PrimitiveRuntime {
  runSteps: RunSteps;
}

type PrimitiveSpec =
  | MapStepSpec
  | FilterStepSpec
  | ReduceStepSpec
  | ParallelStepSpec
  | RetryStepSpec
  | GateStepSpec
  | AgentStepSpec
  | TribunalStepSpec
  | GovernedStepSpec
  | ResearchStepSpec;

interface PrimitiveHandler<TSpec extends PrimitiveSpec> {
  validate?: (spec: Record<string, unknown>, path: string, validateStep: ValidateStep) => void;
  run: (
    spec: TSpec,
    payload: Record<string, unknown>,
    options: StepRunnerOptions,
    stepRecords: StepRecord[],
    runtime: PrimitiveRuntime,
  ) => Promise<Record<string, unknown>>;
}

const PRIMITIVES = {
  map: {
    validate: validateNestedActions,
    run: runMap,
  },
  filter: {
    validate: validateNestedActions,
    run: runFilter,
  },
  reduce: {
    validate: validateNestedActions,
    run: runReduce,
  },
  parallel: {
    validate: validateParallel,
    run: runParallel,
  },
  retry: {
    validate: validateNestedActions,
    run: runRetry,
  },
  gate: {
    validate: validateGate,
    run: runGate,
  },
  agent: {
    validate: validateAgent,
    run: runAgent,
  },
  tribunal: {
    validate: validateTribunal,
    run: runTribunal,
  },
  governed: {
    validate: validateGoverned,
    run: runGoverned,
  },
  research: {
    validate: validateResearch,
    run: runResearch,
  },
} satisfies Record<string, PrimitiveHandler<any>>;

type PrimitiveKey = keyof typeof PRIMITIVES;

const KNOWN_PRIMITIVE_KEYS = new Set(Object.keys(PRIMITIVES));

export function validatePrimitiveStep(
  step: Record<string, unknown>,
  path: string,
  validateStep: ValidateStep,
): PipelineStep {
  const { key, spec } = getPrimitiveEntry(step, path);
  PRIMITIVES[key].validate?.(spec, `${path}.${key}`, validateStep);
  return step as PipelineStep;
}

export async function runPrimitiveStep(
  step: Exclude<PipelineStep, string>,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const { key, spec } = getPrimitiveEntry(step as Record<string, unknown>, "step");
  return PRIMITIVES[key].run(spec as never, payload, options, stepRecords, runtime);
}

function getPrimitiveEntry(
  step: Record<string, unknown>,
  path: string,
): { key: PrimitiveKey; spec: Record<string, unknown> } {
  const keys = Object.keys(step);
  const stepKeys = keys.filter((k): k is PrimitiveKey => KNOWN_PRIMITIVE_KEYS.has(k));

  if (stepKeys.length === 0) {
    throw new Error(
      `${path}: unknown step type. Expected one of: ${[...KNOWN_PRIMITIVE_KEYS].join(", ")}. Got keys: ${keys.join(", ")}`,
    );
  }
  if (stepKeys.length > 1) {
    throw new Error(`${path}: step must have exactly one primitive key, got: ${stepKeys.join(", ")}`);
  }

  const key = stepKeys[0];
  const spec = step[key];
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${path}.${key}: spec must be an object`);
  }

  return { key, spec: spec as Record<string, unknown> };
}

function validateNestedActions(spec: Record<string, unknown>, path: string, validateStep: ValidateStep): void {
  if ("actions" in spec && Array.isArray(spec.actions)) {
    for (let i = 0; i < spec.actions.length; i++) {
      validateStep(spec.actions[i], `${path}.actions[${i}]`);
    }
  }
}

function validateParallel(spec: Record<string, unknown>, path: string, validateStep: ValidateStep): void {
  if (!("branches" in spec) || typeof spec.branches !== "object" || spec.branches === null) {
    return;
  }

  const branches = spec.branches as Record<string, unknown>;
  for (const [branchName, branchDef] of Object.entries(branches)) {
    if (branchDef && typeof branchDef === "object" && "actions" in branchDef) {
      const branchActions = (branchDef as Record<string, unknown>).actions;
      if (Array.isArray(branchActions)) {
        for (let i = 0; i < branchActions.length; i++) {
          validateStep(branchActions[i], `${path}.branches.${branchName}.actions[${i}]`);
        }
      }
    }
  }

  const branchNames = Object.keys(branches);
  const nameSet = new Set(branchNames);
  if (nameSet.size !== branchNames.length) {
    throw new Error(`${path}: duplicate branch names detected`);
  }
}

function validateGate(spec: Record<string, unknown>, path: string): void {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error(`${path}: 'name' must be a non-empty string`);
  }
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
    throw new Error(`${path}: 'prompt' must be a non-empty string`);
  }
  if ("timeout_ms" in spec && spec.timeout_ms !== undefined) {
    if (typeof spec.timeout_ms !== "number" || spec.timeout_ms <= 0) {
      throw new Error(`${path}: 'timeout_ms' must be a positive number when set`);
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runOne() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
  return results;
}

async function runMap(
  spec: MapStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const items = payload[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`map: payload field '${spec.over}' is not an array`);
  }

  if (items.length === 0) {
    return { ...payload, [spec.collect]: [] };
  }

  const concurrency = spec.concurrency ?? 1;
  const onError = spec.onError ?? "stop";
  const collected: unknown[] = [];

  async function processItem(item: unknown, index: number): Promise<unknown> {
    const subInput = { ...payload, [spec.as]: item };
    try {
      return await runtime.runSteps(spec.actions, subInput, options, stepRecords);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (onError === "stop") {
        throw new MapItemFailure(index, item, errMsg, err);
      }
      if (onError === "skip") {
        return undefined;
      }
      return { _error: true, index, error: errMsg, item };
    }
  }

  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      const result = await processItem(items[i], i);
      if (result !== undefined) {
        collected.push(result);
      }
    }
  } else {
    const results = await mapWithConcurrency(items, processItem, concurrency);
    for (const result of results) {
      if (result !== undefined) {
        collected.push(result);
      }
    }
  }

  return { ...payload, [spec.collect]: collected };
}

async function runFilter(
  spec: FilterStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const items = payload[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`filter: payload field '${spec.over}' is not an array`);
  }

  if (items.length === 0) {
    return { ...payload, [spec.collect]: [] };
  }

  const onError = spec.onError ?? "stop";
  const concurrency = spec.concurrency ?? 1;
  const kept: unknown[] = [];

  async function evaluateItem(item: unknown, _index: number): Promise<{ item: unknown; keep: boolean }> {
    const subInput = { ...payload, [spec.as]: item };
    try {
      const result = await runtime.runSteps(spec.actions, subInput, options, stepRecords);
      const keepValue = result[spec.keep_field];
      if (typeof keepValue !== "boolean") {
        throw new Error(
          `filter: keep_field '${spec.keep_field}' must be boolean, got ${typeof keepValue}`,
        );
      }
      return { item, keep: keepValue };
    } catch (err) {
      if (onError === "stop") throw err;
      return { item, keep: false };
    }
  }

  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      const { item, keep } = await evaluateItem(items[i], i);
      if (keep) kept.push(item);
    }
  } else {
    const results = await mapWithConcurrency(items, evaluateItem, concurrency);
    for (const { item, keep } of results) {
      if (keep) kept.push(item);
    }
  }

  return { ...payload, [spec.collect]: kept };
}

async function runReduce(
  spec: ReduceStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const items = payload[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`reduce: payload field '${spec.over}' is not an array`);
  }

  let acc: unknown = spec.init !== undefined ? structuredClone(spec.init) : {};

  for (let i = 0; i < items.length; i++) {
    const subInput = {
      ...payload,
      [spec.item_as]: items[i],
      [spec.acc_as]: acc,
    };
    const result = await runtime.runSteps(spec.actions, subInput, options, stepRecords);
    if (!(spec.acc_as in result)) {
      throw new Error(
        `reduce: sub-pipeline must produce '${spec.acc_as}' in output (iteration ${i})`,
      );
    }
    acc = result[spec.acc_as];
  }

  return { ...payload, [spec.collect]: acc };
}

async function runParallel(
  spec: ParallelStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const branchNames = Object.keys(spec.branches);
  const onError = spec.onError ?? "stop";

  const nameSet = new Set(branchNames);
  if (nameSet.size !== branchNames.length) {
    throw new Error("parallel: duplicate branch names detected");
  }

  const controller = new AbortController();
  let firstError: { name: string; error: string } | null = null;

  const branchPromises = branchNames.map(async (name) => {
    const branchPayload = structuredClone(payload);
    const branchOptions: StepRunnerOptions = { ...options, signal: controller.signal };
    try {
      const result = await runtime.runSteps(
        spec.branches[name].actions,
        branchPayload,
        branchOptions,
        stepRecords,
      );
      return { name, result, error: null };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (onError === "stop" && !firstError) {
        firstError = { name, error: errMsg };
        controller.abort();
      }
      return { name, result: null, error: errMsg };
    }
  });

  const outcomes = await Promise.all(branchPromises);
  let merged = { ...payload };

  if (onError === "stop" && firstError) {
    const { name, error } = firstError as { name: string; error: string };
    throw new StepFailure(`parallel/${name}`, error);
  }

  for (const outcome of outcomes) {
    if (outcome.error) {
      merged[outcome.name] = { _error: true, error: outcome.error, branch: outcome.name };
    } else {
      merged[outcome.name] = outcome.result;
    }
  }

  return merged;
}

async function runRetry(
  spec: RetryStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const maxAttempts = spec.attempts;
  if (maxAttempts < 1) {
    throw new Error("retry: attempts must be at least 1");
  }

  const backoff = spec.backoff ?? "exponential";
  const initialDelay = spec.initial_delay_ms ?? 500;
  const maxDelay = spec.max_delay_ms ?? 10000;
  const retryOn = spec.on ? new Set(spec.on) : null;

  let lastError: Error = new Error("retry: no attempts made");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runtime.runSteps(spec.actions, { ...payload }, options, stepRecords);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (retryOn && !retryOn.has(lastError.constructor.name)) {
        throw lastError;
      }

      if (attempt < maxAttempts) {
        const delay = computeDelay(backoff, attempt, initialDelay, maxDelay);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

function computeDelay(
  backoff: "constant" | "linear" | "exponential",
  attempt: number,
  initialDelay: number,
  maxDelay: number,
): number {
  let delay: number;
  switch (backoff) {
    case "constant":
      delay = initialDelay;
      break;
    case "linear":
      delay = initialDelay * attempt;
      break;
    case "exponential":
      delay = initialDelay * Math.pow(2, attempt - 1);
      break;
  }
  return Math.min(delay, maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGate(
  spec: GateStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const provider = options.gateProvider ?? new StdinGateProvider();
  const collectField = spec.collect ?? `gate_${spec.name}`;
  const opened_at = new Date().toISOString();
  const stepStart = Date.now();

  options.onGateEvent?.({
    type: "gate.opened",
    name: spec.name,
    prompt: spec.prompt,
    opened_at,
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (spec.timeout_ms !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeout_ms);
  }

  let parentAbortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      parentAbortListener = () => controller.abort();
      options.signal.addEventListener("abort", parentAbortListener, { once: true });
    }
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentAbortListener && options.signal) {
      options.signal.removeEventListener("abort", parentAbortListener);
      parentAbortListener = null;
    }
  };

  const recordAndThrow = (errMsg: string): never => {
    stepRecords.push({
      action: `gate:${spec.name}`,
      success: false,
      durationMs: Date.now() - stepStart,
      error: errMsg,
    });
    throw new StepFailure(`gate:${spec.name}`, errMsg);
  };

  let input;
  try {
    input = await provider.requestVerdict({
      name: spec.name,
      prompt: spec.prompt,
      signal: controller.signal,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cleanup();
    if (timedOut) {
      options.onGateEvent?.({
        type: "gate.timeout",
        name: spec.name,
        opened_at,
        timeout_ms: spec.timeout_ms!,
      });
      return recordAndThrow(`gate timeout after ${spec.timeout_ms}ms`);
    }
    return recordAndThrow(errMsg);
  }

  if (controller.signal.aborted) {
    cleanup();
    if (timedOut) {
      options.onGateEvent?.({
        type: "gate.timeout",
        name: spec.name,
        opened_at,
        timeout_ms: spec.timeout_ms!,
      });
      return recordAndThrow(`gate timeout after ${spec.timeout_ms}ms`);
    }
    return recordAndThrow(`gate ${spec.name}: aborted`);
  }

  cleanup();

  const closed_at = new Date().toISOString();
  const result: GateResult = {
    name: spec.name,
    verdict: input.verdict,
    notes: input.notes,
    opened_at,
    closed_at,
  };

  options.onGateEvent?.({
    type: "gate.closed",
    name: spec.name,
    verdict: input.verdict,
    notes: input.notes,
    opened_at,
    closed_at,
  });

  stepRecords.push({
    action: `gate:${spec.name}`,
    success: input.verdict === "pass",
    durationMs: Date.now() - stepStart,
    error: input.verdict === "fail" ? `gate ${spec.name} verdict=fail: ${input.notes}` : undefined,
    gate: { name: spec.name, verdict: input.verdict, notes: input.notes, opened_at, closed_at },
  });

  if (input.verdict === "fail") {
    throw new StepFailure(`gate:${spec.name}`, `verdict=fail — ${input.notes}`);
  }

  return { ...payload, [collectField]: result };
}

// ---------------------------------------------------------------------------
// Agent primitive — dispatch a task to the fleet and await the result
// ---------------------------------------------------------------------------

function validateAgent(spec: Record<string, unknown>, path: string): void {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error(`${path}: 'name' must be a non-empty string`);
  }
  if (typeof spec.capability !== "string" || spec.capability.length === 0) {
    throw new Error(`${path}: 'capability' must be a non-empty string`);
  }
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
    throw new Error(`${path}: 'prompt' must be a non-empty string`);
  }
  if ("timeout_ms" in spec && spec.timeout_ms !== undefined) {
    if (typeof spec.timeout_ms !== "number" || spec.timeout_ms <= 0) {
      throw new Error(`${path}: 'timeout_ms' must be a positive number when set`);
    }
  }
  if ("distribution_mode" in spec && spec.distribution_mode !== undefined) {
    const mode = spec.distribution_mode;
    if (mode !== "offer" && mode !== "direct" && mode !== "delegate") {
      throw new Error(`${path}: 'distribution_mode' must be offer, direct, or delegate`);
    }
    if ((mode === "direct" || mode === "delegate") && typeof spec.target_assistant !== "string") {
      throw new Error(`${path}: distribution_mode '${mode}' requires 'target_assistant'`);
    }
  }
  if ("federate" in spec && spec.federate !== undefined) {
    const fed = spec.federate as Record<string, unknown>;
    if (typeof fed !== "object" || fed === null || typeof fed.principal !== "string" || fed.principal.length === 0) {
      throw new Error(`${path}: 'federate' requires a non-empty 'principal' string`);
    }
    if ("stack" in fed && fed.stack !== undefined && (typeof fed.stack !== "string" || fed.stack.length === 0)) {
      throw new Error(`${path}: 'federate.stack' must be a non-empty string when set`);
    }
  }
}

/**
 * Render `{field}` / `{dotted.path}` placeholders from payload context.
 * Object values are JSON-encoded; missing paths throw — a silently empty
 * prompt section is worse than a loud failure.
 */
export function renderPromptTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (_match, pathExpr: string) => {
    let value: unknown = payload;
    for (const segment of pathExpr.split(".")) {
      if (value === null || typeof value !== "object" || !(segment in (value as Record<string, unknown>))) {
        throw new Error(`agent prompt template: payload has no field '${pathExpr}'`);
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  });
}

async function runAgent(
  spec: AgentStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const provider = options.agentProvider;
  const stepStart = Date.now();

  const recordAndThrow = (errMsg: string): never => {
    stepRecords.push({
      action: `agent:${spec.name}`,
      success: false,
      durationMs: Date.now() - stepStart,
      error: errMsg,
    });
    throw new StepFailure(`agent:${spec.name}`, errMsg);
  };

  if (!provider) {
    return recordAndThrow(
      "no agentProvider configured — pipelines with agent steps require one (StepRunnerOptions.agentProvider)",
    );
  }

  const prompt = renderPromptTemplate(spec.prompt, payload);
  const taskSpec = {
    capability: spec.capability,
    prompt,
    sovereignty: spec.sovereignty,
    distribution_mode: spec.distribution_mode,
    target_assistant: spec.target_assistant,
    federate: spec.federate,
    timeout_ms: spec.timeout_ms,
  };

  // Runner owns the timeout — provider only sees the AbortSignal (gate precedent).
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (spec.timeout_ms !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeout_ms);
  }

  let parentAbortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      parentAbortListener = () => controller.abort();
      options.signal.addEventListener("abort", parentAbortListener, { once: true });
    }
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentAbortListener && options.signal) {
      options.signal.removeEventListener("abort", parentAbortListener);
      parentAbortListener = null;
    }
  };

  const dispatched_at = new Date().toISOString();
  let result: AgentTaskResult;
  try {
    // The provider mints the task_id and reports it through onDispatched the
    // moment the task hits the wire — so the dispatched event carries the real
    // id and observers can correlate it with the completed/failed event.
    result = await provider.dispatch(taskSpec, {
      signal: controller.signal,
      onDispatched: ({ task_id }) => {
        options.onAgentEvent?.({
          type: "agent.dispatched",
          name: spec.name,
          capability: spec.capability,
          task_id,
          dispatched_at,
        });
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cleanup();
    if (timedOut) {
      options.onAgentEvent?.({
        type: "agent.timeout",
        name: spec.name,
        capability: spec.capability,
        task_id: "unknown",
        timeout_ms: spec.timeout_ms!,
      });
      return recordAndThrow(`agent task timeout after ${spec.timeout_ms}ms`);
    }
    options.onAgentEvent?.({
      type: "agent.failed",
      name: spec.name,
      capability: spec.capability,
      task_id: "unknown",
      error: errMsg,
    });
    return recordAndThrow(errMsg);
  }
  cleanup();

  if (result.status === "failed") {
    options.onAgentEvent?.({
      type: "agent.failed",
      name: spec.name,
      capability: spec.capability,
      task_id: result.task_id,
      error: result.error ?? "agent task failed",
    });
    return recordAndThrow(result.error ?? "agent task failed");
  }

  options.onAgentEvent?.({
    type: "agent.completed",
    name: spec.name,
    capability: spec.capability,
    task_id: result.task_id,
    duration_ms: result.duration_ms,
  });

  stepRecords.push({
    action: `agent:${spec.name}`,
    success: true,
    durationMs: Date.now() - stepStart,
  });

  // Store the agent's RESULT VALUE under the collect field — not the full
  // agent task result record. This matches map/filter/reduce collect (which
  // store values) so a downstream block reading a scalar (`collect: email` →
  // A_FETCH_HIBP) gets the value directly.
  //
  // Deliberate trade-off: the collected payload now carries ONLY the value.
  // The agent task metadata (task_id, status, duration, error) is intentionally
  // moved OUT of the data plane — a later step can no longer read it off the
  // collected field. It is observable on the onAgentEvent stream instead
  // (agent.dispatched/completed/failed). A failed task recordAndThrow()s above
  // before reaching here, so on this path the status is always "completed";
  // a step that needs the error value sees it via the thrown StepFailure, not
  // the payload.
  const collectField = spec.collect ?? `agent_${spec.name}`;
  return { ...payload, [collectField]: result.output };
}

// ---------------------------------------------------------------------------
// Tribunal primitive — model-diverse agent panel adjudicates a judgment call
// ---------------------------------------------------------------------------

function validateSeat(seat: unknown, path: string): void {
  if (seat === null || typeof seat !== "object" || Array.isArray(seat)) {
    throw new Error(`${path}: seat must be an object`);
  }
  const s = seat as Record<string, unknown>;
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new Error(`${path}: 'name' must be a non-empty string`);
  }
  if (typeof s.capability !== "string" || s.capability.length === 0) {
    throw new Error(`${path}: 'capability' must be a non-empty string`);
  }
  if (typeof s.prompt !== "string" || s.prompt.length === 0) {
    throw new Error(`${path}: 'prompt' must be a non-empty string`);
  }
  if ("timeout_ms" in s && s.timeout_ms !== undefined) {
    if (typeof s.timeout_ms !== "number" || s.timeout_ms <= 0) {
      throw new Error(`${path}: 'timeout_ms' must be a positive number when set`);
    }
  }
}

function validateTribunal(spec: Record<string, unknown>, path: string): void {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error(`${path}: 'name' must be a non-empty string`);
  }
  if (!Array.isArray(spec.seats) || spec.seats.length === 0) {
    throw new Error(`${path}: 'seats' must be a non-empty array — an empty panel cannot rule`);
  }
  for (let i = 0; i < spec.seats.length; i++) {
    validateSeat(spec.seats[i], `${path}.seats[${i}]`);
  }
  const seatNames = (spec.seats as Record<string, unknown>[]).map((s) => s.name);
  if (new Set(seatNames).size !== seatNames.length) {
    throw new Error(`${path}: duplicate seat names detected`);
  }
  if ("tiebreaker" in spec && spec.tiebreaker !== undefined) {
    validateSeat(spec.tiebreaker, `${path}.tiebreaker`);
  }
  if ("confidence_bar" in spec && spec.confidence_bar !== undefined) {
    const bar = spec.confidence_bar;
    if (typeof bar !== "number" || bar < 0 || bar > 1) {
      throw new Error(`${path}: 'confidence_bar' must be a number in [0, 1]`);
    }
  }
  if ("on_defer" in spec && spec.on_defer !== undefined && spec.on_defer !== "fail" && spec.on_defer !== "continue") {
    throw new Error(`${path}: 'on_defer' must be "fail" or "continue"`);
  }
  if ("timeout_ms" in spec && spec.timeout_ms !== undefined) {
    if (typeof spec.timeout_ms !== "number" || spec.timeout_ms <= 0) {
      throw new Error(`${path}: 'timeout_ms' must be a positive number when set`);
    }
  }
}

/**
 * Dispatch one seat and return its vote. Total: dispatch failures, timeouts,
 * and aborts all coerce to an abstain vote with a recorded cause — one broken
 * seat must never crash the panel mid-session. The runner owns the timer;
 * the provider only sees the AbortSignal (gate/agent precedent).
 */
async function dispatchSeat(
  seat: SeatSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  defaultTimeoutMs: number | undefined,
): Promise<SeatVote> {
  let prompt: string;
  try {
    prompt = renderPromptTemplate(seat.prompt, payload) + VOTE_FORMAT_INSTRUCTION;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return abstainVote(seat.name, `prompt template error: ${errMsg}`);
  }

  const timeoutMs = seat.timeout_ms ?? defaultTimeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  let parentAbortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      parentAbortListener = () => controller.abort();
      options.signal.addEventListener("abort", parentAbortListener, { once: true });
    }
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentAbortListener && options.signal) {
      options.signal.removeEventListener("abort", parentAbortListener);
      parentAbortListener = null;
    }
  };

  try {
    const result = await options.agentProvider!.dispatch(
      {
        capability: seat.capability,
        prompt,
        sovereignty: seat.sovereignty,
        timeout_ms: timeoutMs,
      },
      { signal: controller.signal },
    );
    cleanup();
    if (result.status === "failed") {
      return abstainVote(seat.name, result.error ?? "seat task failed", result.model);
    }
    return parseSeatVote(seat.name, result.output, result.model);
  } catch (err) {
    cleanup();
    const errMsg = err instanceof Error ? err.message : String(err);
    return abstainVote(seat.name, timedOut ? `seat timeout after ${timeoutMs}ms` : errMsg);
  }
}

async function runTribunal(
  spec: TribunalStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const stepStart = Date.now();

  const recordAndThrow = (errMsg: string, verdict?: TribunalVerdict): never => {
    stepRecords.push({
      action: `tribunal:${spec.name}`,
      success: false,
      durationMs: Date.now() - stepStart,
      error: errMsg,
      tribunal: verdict,
    });
    throw new StepFailure(`tribunal:${spec.name}`, errMsg);
  };

  if (!options.agentProvider) {
    return recordAndThrow(
      "no agentProvider configured — pipelines with tribunal steps require one (StepRunnerOptions.agentProvider)",
    );
  }

  // Diversity rule (Gate 22) applies BEFORE dispatch so the reassigned seat
  // is dispatched with its restricted class, never re-dispatched.
  const { seats, diversity } = planDiversity(spec.seats);
  const convened_at = new Date().toISOString();

  options.onTribunalEvent?.({
    type: "tribunal.convened",
    name: spec.name,
    seats: seats.map((s) => s.name),
    convened_at,
  });

  const votes = await Promise.all(
    seats.map(async (seat) => {
      const vote = await dispatchSeat(seat, payload, options, spec.timeout_ms);
      options.onTribunalEvent?.({ type: "tribunal.seat_voted", name: spec.name, vote });
      return vote;
    }),
  );

  // A parent abort mid-panel is a cancelled step, not an incapacitated panel.
  if (options.signal?.aborted) {
    return recordAndThrow(`tribunal ${spec.name}: aborted`);
  }

  let tally = aggregate(votes, spec.confidence_bar ?? 0);
  let tiebreak: SeatVote | undefined;

  if (tally.outcome === "tie") {
    if (spec.tiebreaker) {
      tiebreak = await dispatchSeat(spec.tiebreaker, payload, options, spec.timeout_ms);
      options.onTribunalEvent?.({ type: "tribunal.tiebreak", name: spec.name, vote: tiebreak });
      if (options.signal?.aborted) {
        return recordAndThrow(`tribunal ${spec.name}: aborted`);
      }
      tally = aggregate([...votes, tiebreak], spec.confidence_bar ?? 0);
      if (tally.outcome === "tie") {
        tally = { outcome: "defer", reason: `${tally.reason} — tie persisted after tiebreaker` };
      }
    } else {
      tally = { outcome: "defer", reason: `${tally.reason} — no tiebreaker configured` };
    }
  }

  const allVotes = tiebreak ? [...votes, tiebreak] : votes;
  const finalDiversity = checkPosthocDiversity(allVotes, diversity);
  const ruled = applyDiversityDowngrade(
    { outcome: tally.outcome as TribunalRuling, reason: tally.reason },
    finalDiversity,
  );

  const verdict: TribunalVerdict = {
    name: spec.name,
    verdict: ruled.outcome,
    reason: ruled.reason,
    votes,
    diversity: finalDiversity,
    tiebreak,
    convened_at,
    ruled_at: new Date().toISOString(),
  };

  options.onTribunalEvent?.({ type: "tribunal.verdict", name: spec.name, verdict });

  if (verdict.verdict === "deny") {
    return recordAndThrow(`verdict=deny — ${verdict.reason}`, verdict);
  }
  if (verdict.verdict === "defer" && (spec.on_defer ?? "fail") === "fail") {
    return recordAndThrow(`verdict=defer — ${verdict.reason} (set on_defer: "continue" to handle downstream)`, verdict);
  }

  stepRecords.push({
    action: `tribunal:${spec.name}`,
    success: true,
    durationMs: Date.now() - stepStart,
    tribunal: verdict,
  });

  const collectField = spec.collect ?? `tribunal_${spec.name}`;
  return { ...payload, [collectField]: verdict };
}

// ---------------------------------------------------------------------------
// Governed primitive — the layered L0→L1→L2 governed-action stack
// ---------------------------------------------------------------------------

function validateGoverned(spec: Record<string, unknown>, path: string, validateStep: ValidateStep): void {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error(`${path}: 'name' must be a non-empty string`);
  }
  if (typeof spec.tool !== "string" || spec.tool.length === 0) {
    throw new Error(`${path}: 'tool' must be a non-empty string`);
  }
  if (!Array.isArray(spec.input_fields) || spec.input_fields.length === 0 || !spec.input_fields.every((f) => typeof f === "string" && f.length > 0)) {
    throw new Error(`${path}: 'input_fields' must be a non-empty array of field names`);
  }
  if (spec.policy === null || typeof spec.policy !== "object" || Array.isArray(spec.policy)) {
    throw new Error(`${path}: 'policy' must be an inline policy object (a governed action without a policy cannot exist)`);
  }
  if ("tribunal" in spec && spec.tribunal !== undefined) {
    if (spec.tribunal === null || typeof spec.tribunal !== "object" || Array.isArray(spec.tribunal)) {
      throw new Error(`${path}.tribunal: must be an object`);
    }
    validateTribunal(spec.tribunal as Record<string, unknown>, `${path}.tribunal`);
  }
  if ("gate" in spec && spec.gate !== undefined) {
    const gate = spec.gate as Record<string, unknown>;
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      throw new Error(`${path}.gate: must be an object`);
    }
    if (typeof gate.name !== "string" || gate.name.length === 0) {
      throw new Error(`${path}.gate: 'name' must be a non-empty string`);
    }
    if ("prompt" in gate && gate.prompt !== undefined && (typeof gate.prompt !== "string" || gate.prompt.length === 0)) {
      throw new Error(`${path}.gate: 'prompt' must be a non-empty string when set`);
    }
    if ("timeout_ms" in gate && gate.timeout_ms !== undefined && (typeof gate.timeout_ms !== "number" || gate.timeout_ms <= 0)) {
      throw new Error(`${path}.gate: 'timeout_ms' must be a positive number when set`);
    }
  }
  void validateStep;
}

/**
 * Run the layered governed-action stack. Routing is monotone descent in
 * certainty: refusals are terminal at every layer; only uncertainty travels
 * down. Every joint fails closed:
 *
 *   L0 allow → continue (panel skipped) · deny → halt
 *   L0 ask   → tribunal (or gate when no tribunal; neither → halt)
 *   L1 allow → continue · deny → halt (no gate appeal) · defer → gate
 *   L2 pass  → continue · fail/timeout → halt
 */
async function runGoverned(
  spec: GovernedStepSpec,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
  runtime: PrimitiveRuntime,
): Promise<Record<string, unknown>> {
  const stepStart = Date.now();
  const evaluated_at = new Date().toISOString();

  const finish = (
    result: GovernedResult,
  ): Record<string, unknown> => {
    options.onGovernedEvent?.({ type: "governed.resolved", name: spec.name, result });
    stepRecords.push({
      action: `governed:${spec.name}`,
      success: true,
      durationMs: Date.now() - stepStart,
      governed: result,
    });
    const collectField = spec.collect ?? `governed_${spec.name}`;
    return { ...payload, [collectField]: result };
  };

  const refuse = (result: GovernedResult, errMsg: string): never => {
    options.onGovernedEvent?.({ type: "governed.resolved", name: spec.name, result });
    stepRecords.push({
      action: `governed:${spec.name}`,
      success: false,
      durationMs: Date.now() - stepStart,
      error: errMsg,
      governed: result,
    });
    throw new StepFailure(`governed:${spec.name}`, errMsg);
  };

  // ---- L0: deterministic policy, zero LLM cost --------------------------
  const toolInput: Record<string, unknown> = {};
  for (const field of spec.input_fields) {
    if (field in payload) toolInput[field] = payload[field];
    // Absent fields stay absent: a rule matching on a missing field doesn't
    // match, and the policy default (fail-closed) decides.
  }
  const l0 = evaluate(spec.tool, toolInput, spec.policy);

  const baseResult = (outcome: "allow" | "deny", resolved_by: GovernedResult["resolved_by"]): GovernedResult => ({
    name: spec.name,
    outcome,
    resolved_by,
    l0,
    evaluated_at,
    resolved_at: new Date().toISOString(),
  });
  options.onGovernedEvent?.({ type: "governed.l0", name: spec.name, tool: spec.tool, decision: l0, evaluated_at });

  if (l0.decision === "deny") {
    return refuse(baseResult("deny", "policy"), `L0 deny — ${l0.reason}`);
  }
  if (l0.decision === "allow") {
    return finish(baseResult("allow", "policy"));
  }

  // ---- L0 said ask: escalate ---------------------------------------------
  let tribunalVerdict: TribunalVerdict | undefined;
  let escalationReason = `policy ask — ${l0.reason}`;

  if (spec.tribunal) {
    options.onGovernedEvent?.({ type: "governed.escalated", name: spec.name, to: "tribunal", reason: escalationReason });
    const innerCollect = `__governed_tribunal_${spec.name}`;
    const tribunalSpec: TribunalStepSpec = {
      ...(spec.tribunal as TribunalStepSpec),
      collect: innerCollect,
      on_defer: "continue", // governed owns the defer routing
    };
    let tribunalPayload: Record<string, unknown>;
    const recordsBeforeTribunal = stepRecords.length;
    try {
      tribunalPayload = await runTribunal(tribunalSpec, payload, options, stepRecords);
    } catch (err) {
      // Tribunal deny (or abort) — terminal. Recover the verdict from the
      // record THIS call pushed (never an earlier step's — sage PR #35).
      const errMsg = err instanceof Error ? err.message : String(err);
      const ownRecord = stepRecords.slice(recordsBeforeTribunal).find((r) => r.tribunal !== undefined);
      const result = baseResult("deny", "tribunal");
      result.tribunal = ownRecord?.tribunal;
      return refuse(result, errMsg);
    }
    tribunalVerdict = tribunalPayload[innerCollect] as TribunalVerdict;

    if (tribunalVerdict.verdict === "allow") {
      const result = baseResult("allow", "tribunal");
      result.tribunal = tribunalVerdict;
      return finish(result);
    }
    // defer → fall through to the gate
    escalationReason = `tribunal defer — ${tribunalVerdict.reason}`;
  }

  // ---- L2: the human gate -------------------------------------------------
  if (!spec.gate) {
    const result = baseResult("deny", spec.tribunal ? "tribunal" : "policy");
    result.tribunal = tribunalVerdict;
    return refuse(
      result,
      `${escalationReason} — no gate configured, failing closed (an unresolved judgment call must not proceed)`,
    );
  }

  options.onGovernedEvent?.({ type: "governed.escalated", name: spec.name, to: "gate", reason: escalationReason });
  const innerGateCollect = `__governed_gate_${spec.name}`;
  const gateSpec: GateStepSpec = {
    name: spec.gate.name,
    prompt: spec.gate.prompt ?? `[governed:${spec.name}] ${escalationReason}. pass to allow, fail to refuse.`,
    timeout_ms: spec.gate.timeout_ms,
    collect: innerGateCollect,
  };
  let gatePayload: Record<string, unknown>;
  const recordsBeforeGate = stepRecords.length;
  try {
    gatePayload = await runGate(gateSpec, payload, options, stepRecords);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const ownRecord = stepRecords.slice(recordsBeforeGate).find((r) => r.gate !== undefined);
    const result = baseResult("deny", "gate");
    result.tribunal = tribunalVerdict;
    result.gate = ownRecord?.gate;
    return refuse(result, errMsg);
  }

  const gateResult = gatePayload[innerGateCollect] as GateResult;
  const result = baseResult("allow", "gate");
  result.tribunal = tribunalVerdict;
  result.gate = gateResult;
  void runtime;
  return finish(result);
}
