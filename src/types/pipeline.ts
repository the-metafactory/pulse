/**
 * Pipeline Step Types — iteration and composition primitives.
 *
 * A pipeline step is either a string (action name) or an object with
 * a single keyword identifying the primitive. The runner dispatches
 * based on which keyword is present.
 */

import type { AgentStepSpec } from "./agent";
import type { TribunalStepSpec } from "./tribunal";
import type { GovernedStepSpec } from "./governed";
import type { ResearchStepSpec } from "./research";

// Agent step types live in ./agent (shared with the capability surface);
// re-exported here so pipeline consumers see one vocabulary.
export type {
  AgentStepSpec,
  AgentSovereignty,
  AgentTaskSpec,
  AgentTaskResult,
  AgentProvider,
  AgentEvent,
} from "./agent";

// Tribunal step types live in ./tribunal (governance L1, P-701);
// re-exported so pipeline consumers see one vocabulary.
export type {
  TribunalStepSpec,
  SeatSpec,
  SeatVote,
  SeatVerdict,
  TribunalRuling,
  TribunalVerdict,
  TribunalDiversity,
  TribunalEvent,
} from "./tribunal";

// Governed step types live in ./governed (the L0→L1→L2 stack, P-702);
// re-exported so pipeline consumers see one vocabulary.
export type {
  GovernedStepSpec,
  GovernedResult,
  GovernedEvent,
  GovernedTribunalSpec,
  GovernedGateSpec,
} from "./governed";

// Research step types live in ./research; re-exported likewise.
export type { ResearchStepSpec, ResearchStats, ResearchEvent } from "./research";

// ---------------------------------------------------------------------------
// Step type — discriminated union
// ---------------------------------------------------------------------------

export type PipelineStep =
  | string
  | { map: MapStepSpec }
  | { filter: FilterStepSpec }
  | { reduce: ReduceStepSpec }
  | { parallel: ParallelStepSpec }
  | { retry: RetryStepSpec }
  | { gate: GateStepSpec }
  | { agent: AgentStepSpec }
  | { tribunal: TribunalStepSpec }
  | { governed: GovernedStepSpec }
  | { research: ResearchStepSpec };

// ---------------------------------------------------------------------------
// Primitive specs
// ---------------------------------------------------------------------------

export interface MapStepSpec {
  /** Field in payload context holding the array to iterate */
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
  /** Field in payload context holding the array to filter */
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
  /** Field in payload context holding the array to fold */
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

// ---------------------------------------------------------------------------
// Step lifecycle events — plain action steps
// ---------------------------------------------------------------------------

/**
 * Lifecycle event for a plain (string) action step — one kind of Step
 * (Step = Action | Primitive). Emitted via the optional
 * StepRunnerOptions.onActionStepEvent hook so hosts can surface per-step
 * execution progress — e.g. the SOC demo posting one Mattermost thread reply
 * per step. Composition primitives have their own event channels (onGateEvent,
 * onAgentEvent, onTribunalEvent, onGovernedEvent); this one covers the plain
 * action steps that previously executed silently. No determinism is implied —
 * actions run arbitrary code.
 */
export type ActionStepEvent =
  | { type: "step.started"; action: string; started_at: string }
  | { type: "step.completed"; action: string; durationMs: number; output_fields: string[] }
  | { type: "step.failed"; action: string; durationMs: number; error: string };

// ---------------------------------------------------------------------------
// Gate primitive — pause execution and wait for operator verdict
// ---------------------------------------------------------------------------

/**
 * Operator verdict on a gate. Pipeline continues when "pass"; the runner
 * raises StepFailure when "fail" so the surrounding flow can react.
 */
export type GateVerdict = "pass" | "fail";

export interface GateInput {
  verdict: GateVerdict;
  notes: string;
}

/**
 * Captured gate result — what the runner merges into payload context.
 * Timestamps are ISO-8601 UTC.
 */
export interface GateResult extends GateInput {
  name: string;
  opened_at: string;
  closed_at: string;
}

/**
 * Pluggable input source. Default implementation reads stdin (CLI runner);
 * meta-factory and other hosts can inject HTTP/UI providers.
 *
 * The runner owns the timeout — providers receive only the AbortSignal and
 * MUST reject the returned promise when the signal fires. This keeps timeout
 * semantics consistent across implementations regardless of how each provider
 * tracks elapsed time internally.
 */
export interface GateProvider {
  requestVerdict(spec: {
    name: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<GateInput>;
}

/**
 * Gate lifecycle event. Emitted via the optional StepRunnerOptions.onGateEvent
 * hook so hosts can pipe gate activity into their own trace systems.
 */
export type GateEvent =
  | { type: "gate.opened"; name: string; prompt: string; opened_at: string }
  | { type: "gate.closed"; name: string; verdict: GateVerdict; notes: string; opened_at: string; closed_at: string }
  | { type: "gate.timeout"; name: string; opened_at: string; timeout_ms: number };

export interface GateStepSpec {
  /** Stable identifier for this gate (used in events + traces) */
  name: string;
  /** Operator-facing prompt shown when the gate opens */
  prompt: string;
  /** Optional timeout in milliseconds. Omit for indefinite wait. */
  timeout_ms?: number;
  /** Field name to write the GateResult under (default: `gate_${name}`) */
  collect?: string;
}
