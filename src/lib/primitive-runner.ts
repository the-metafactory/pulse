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
} from "../types/pipeline";

export class StepFailure extends Error {
  constructor(
    public readonly step: string,
    public readonly causeError: string,
  ) {
    super(`Step failed: ${step} — ${causeError}`);
    this.name = "StepFailure";
  }
}

export class MapItemFailure extends Error {
  constructor(
    public readonly index: number,
    public readonly item: unknown,
    public readonly causeError: string,
  ) {
    super(`Map item ${index} failed: ${causeError}`);
    this.name = "MapItemFailure";
  }
}

export interface StepRecord {
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
  /** Populated for gate steps — full GateResult so downstream traces can audit verdict + notes. */
  gate?: GateResult;
}

/** Options threaded through the step runner, extending ActionRunnerOptions */
export interface StepRunnerOptions extends ActionRunnerOptions {
  mode?: "local" | "cloud";
  /** AbortSignal for cooperative cancellation (used by parallel branches) */
  signal?: AbortSignal;
  /** Gate input source. Defaults to StdinGateProvider when omitted. */
  gateProvider?: GateProvider;
  /** Optional sink for gate lifecycle events. Hosts can pipe to traces, dashboards, etc. */
  onGateEvent?: (event: GateEvent) => void;
  /** Optional sink for agent lifecycle events. */
  onAgentEvent?: (event: AgentEvent) => void;
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
  | AgentStepSpec;

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
        throw new MapItemFailure(index, item, errMsg);
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

  const collectField = spec.collect ?? `agent_${spec.name}`;
  return { ...payload, [collectField]: result };
}
