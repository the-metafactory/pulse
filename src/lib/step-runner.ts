/**
 * Step Runner — dispatcher and handlers for iteration/composition primitives.
 *
 * Replaces the linear for-loop in runPipeline with a recursive step dispatcher
 * that handles string (action) steps and object (primitive) steps.
 */

import { runAction, type ActionRunnerOptions } from "./action-runner";
import type {
  PipelineStep,
  MapStepSpec,
  FilterStepSpec,
  ReduceStepSpec,
  ParallelStepSpec,
  RetryStepSpec,
} from "../types/pipeline";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class StepFailure extends Error {
  constructor(
    public readonly step: string,
    public readonly cause_error: string,
  ) {
    super(`Step failed: ${step} — ${cause_error}`);
    this.name = "StepFailure";
  }
}

export class MapItemFailure extends Error {
  constructor(
    public readonly index: number,
    public readonly item: unknown,
    public readonly cause_error: string,
  ) {
    super(`Map item ${index} failed: ${cause_error}`);
    this.name = "MapItemFailure";
  }
}

// ---------------------------------------------------------------------------
// Step result tracking
// ---------------------------------------------------------------------------

export interface StepRecord {
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

export async function runSteps(
  steps: PipelineStep[],
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[] = [],
): Promise<Record<string, unknown>> {
  let current = { ...upstream };
  for (const step of steps) {
    current = await runStep(step, current, options, stepRecords);
  }
  return current;
}

export async function runStep(
  step: PipelineStep,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[] = [],
): Promise<Record<string, unknown>> {
  if (typeof step === "string") {
    return runActionStep(step, upstream, options, stepRecords);
  }

  if ("map" in step) return runMap(step.map, upstream, options, stepRecords);
  if ("filter" in step) return runFilter(step.filter, upstream, options, stepRecords);
  if ("reduce" in step) return runReduce(step.reduce, upstream, options, stepRecords);
  if ("parallel" in step) return runParallel(step.parallel, upstream, options, stepRecords);
  if ("retry" in step) return runRetry(step.retry, upstream, options, stepRecords);

  throw new Error(`Unknown pipeline step shape: ${JSON.stringify(step)}`);
}

// ---------------------------------------------------------------------------
// String (action) step — existing behavior
// ---------------------------------------------------------------------------

async function runActionStep(
  actionName: string,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const stepStart = Date.now();
  const result = await runAction(actionName, upstream, {
    ...options,
    traceId: crypto.randomUUID(),
  });
  const durationMs = Date.now() - stepStart;

  stepRecords.push({
    action: actionName,
    success: result.success,
    durationMs,
    error: result.error,
  });

  if (!result.success) {
    throw new StepFailure(actionName, result.error ?? "unknown error");
  }

  if (result.output && typeof result.output === "object") {
    return { ...upstream, ...(result.output as Record<string, unknown>) };
  }
  return upstream;
}

// ---------------------------------------------------------------------------
// Concurrency helper — simple worker pool
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// map — fan-out over a collection
// ---------------------------------------------------------------------------

async function runMap(
  spec: MapStepSpec,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const items = upstream[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`map: upstream field '${spec.over}' is not an array`);
  }

  if (items.length === 0) {
    return { ...upstream, [spec.collect]: [] };
  }

  const concurrency = spec.concurrency ?? 1;
  const onError = spec.onError ?? "stop";
  const collected: unknown[] = [];

  async function processItem(item: unknown, index: number): Promise<unknown> {
    const subInput = { ...upstream, [spec.as]: item };
    try {
      return await runSteps(spec.actions, subInput, options, stepRecords);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (onError === "stop") {
        throw new MapItemFailure(index, item, errMsg);
      }
      if (onError === "skip") {
        return undefined; // sentinel
      }
      // onError === "collect"
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

  return { ...upstream, [spec.collect]: collected };
}

// ---------------------------------------------------------------------------
// filter — drop items that fail a predicate
// ---------------------------------------------------------------------------

async function runFilter(
  spec: FilterStepSpec,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const items = upstream[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`filter: upstream field '${spec.over}' is not an array`);
  }

  if (items.length === 0) {
    return { ...upstream, [spec.collect]: [] };
  }

  const onError = spec.onError ?? "stop";
  const concurrency = spec.concurrency ?? 1;
  const kept: unknown[] = [];

  async function evaluateItem(item: unknown, _index: number): Promise<{ item: unknown; keep: boolean }> {
    const subInput = { ...upstream, [spec.as]: item };
    try {
      const result = await runSteps(spec.actions, subInput, options, stepRecords);
      const keepValue = result[spec.keep_field];
      if (typeof keepValue !== "boolean") {
        throw new Error(
          `filter: keep_field '${spec.keep_field}' must be boolean, got ${typeof keepValue}`,
        );
      }
      return { item, keep: keepValue };
    } catch (err) {
      if (onError === "stop") throw err;
      // skip: treat as "don't keep"
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

  return { ...upstream, [spec.collect]: kept };
}

// ---------------------------------------------------------------------------
// reduce — stateful fold
// ---------------------------------------------------------------------------

async function runReduce(
  spec: ReduceStepSpec,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const items = upstream[spec.over];
  if (!Array.isArray(items)) {
    throw new Error(`reduce: upstream field '${spec.over}' is not an array`);
  }

  let acc: unknown = spec.init !== undefined ? structuredClone(spec.init) : {};

  for (let i = 0; i < items.length; i++) {
    const subInput = {
      ...upstream,
      [spec.item_as]: items[i],
      [spec.acc_as]: acc,
    };
    const result = await runSteps(spec.actions, subInput, options, stepRecords);
    if (!(spec.acc_as in result)) {
      throw new Error(
        `reduce: sub-pipeline must produce '${spec.acc_as}' in output (iteration ${i})`,
      );
    }
    acc = result[spec.acc_as];
  }

  return { ...upstream, [spec.collect]: acc };
}

// ---------------------------------------------------------------------------
// parallel — heterogeneous named branches
// ---------------------------------------------------------------------------

async function runParallel(
  spec: ParallelStepSpec,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const branchNames = Object.keys(spec.branches);
  const onError = spec.onError ?? "stop";

  // Validate no branch name collisions (parse-time guarantee, but enforce at runtime too)
  const nameSet = new Set(branchNames);
  if (nameSet.size !== branchNames.length) {
    throw new Error("parallel: duplicate branch names detected");
  }

  const branchPromises = branchNames.map(async (name) => {
    const branchUpstream = structuredClone(upstream);
    try {
      const result = await runSteps(
        spec.branches[name].actions,
        branchUpstream,
        options,
        stepRecords,
      );
      return { name, result, error: null };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { name, result: null, error: errMsg };
    }
  });

  const outcomes = await Promise.all(branchPromises);
  let merged = { ...upstream };

  for (const outcome of outcomes) {
    if (outcome.error) {
      if (onError === "stop") {
        throw new StepFailure(`parallel/${outcome.name}`, outcome.error);
      }
      // collect mode
      merged[outcome.name] = { _error: true, error: outcome.error, branch: outcome.name };
    } else {
      merged[outcome.name] = outcome.result;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// retry — composition primitive for reliability
// ---------------------------------------------------------------------------

async function runRetry(
  spec: RetryStepSpec,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" },
  stepRecords: StepRecord[],
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
      return await runSteps(spec.actions, { ...upstream }, options, stepRecords);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if this error type should be retried
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
