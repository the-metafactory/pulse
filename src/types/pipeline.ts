/**
 * Pipeline Step Types — iteration and composition primitives.
 *
 * A pipeline step is either a string (action name) or an object with
 * a single keyword identifying the primitive. The runner dispatches
 * based on which keyword is present.
 */

// ---------------------------------------------------------------------------
// Step type — discriminated union
// ---------------------------------------------------------------------------

export type PipelineStep =
  | string
  | { map: MapStepSpec }
  | { filter: FilterStepSpec }
  | { reduce: ReduceStepSpec }
  | { parallel: ParallelStepSpec }
  | { retry: RetryStepSpec };

// ---------------------------------------------------------------------------
// Primitive specs
// ---------------------------------------------------------------------------

export interface MapStepSpec {
  /** Field in upstream context holding the array to iterate */
  over: string;
  /** Name bound in each sub-pipeline invocation */
  as: string;
  /** Sub-pipeline steps to run per item */
  actions: PipelineStep[];
  /** Field to write collected sub-pipeline outputs to */
  collect: string;
  /** Max concurrent sub-pipeline runs (default: 1) */
  concurrency?: number;
  /** Error handling: stop (default), skip failed items, or collect error entries */
  onError?: "stop" | "skip" | "collect";
}

export interface FilterStepSpec {
  /** Field in upstream context holding the array to filter */
  over: string;
  /** Name bound in each sub-pipeline invocation */
  as: string;
  /** Sub-pipeline steps — must produce a boolean field */
  actions: PipelineStep[];
  /** Which sub-pipeline output field is the predicate result */
  keep_field: string;
  /** Field to write filtered results to */
  collect: string;
  /** Max concurrent predicate evaluations (default: 1) */
  concurrency?: number;
  /** Error handling: stop (default) or skip failed items */
  onError?: "stop" | "skip";
}

export interface ReduceStepSpec {
  /** Field in upstream context holding the array to fold */
  over: string;
  /** Initial accumulator value */
  init: unknown;
  /** Name for the current item in each iteration */
  item_as: string;
  /** Name for the current accumulator in each iteration */
  acc_as: string;
  /** Sub-pipeline steps — must produce acc_as in output */
  actions: PipelineStep[];
  /** Field to write final accumulator to */
  collect: string;
  /** Error handling: only stop is valid for reduce */
  onError?: "stop";
}

export interface ParallelStepSpec {
  /** Named branches to run concurrently */
  branches: Record<string, { actions: PipelineStep[] }>;
  /** Error handling: stop (default) or collect errors */
  onError?: "stop" | "collect";
}

export interface RetryStepSpec {
  /** Maximum number of attempts */
  attempts: number;
  /** Backoff strategy (default: exponential) */
  backoff?: "constant" | "linear" | "exponential";
  /** Initial delay in milliseconds (default: 500) */
  initial_delay_ms?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  max_delay_ms?: number;
  /** Error class names to retry (retry all if omitted) */
  on?: string[];
  /** Sub-pipeline steps to wrap with retry */
  actions: PipelineStep[];
}
