/**
 * Step runner options and records — what every step handler is handed, plus
 * prompt rendering and the per-run state runPipeline adds. A leaf module
 * (type-only imports), so primitives that live in their own modules (research)
 * import it without a cycle through the primitive runner.
 */

import type { ActionRunnerOptions } from "./action-runner";
import type { ChatModel } from "./chat-model";
import type { ActionStepEvent, AgentEvent, GateEvent, GateProvider, GateResult } from "../types/pipeline";
import type { TribunalEvent, TribunalVerdict } from "../types/tribunal";
import type { GovernedEvent, GovernedResult } from "../types/governed";
import type { ResearchEvent, ResearchStats } from "../types/research";

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
  /** Populated for research steps — rounds, tool calls, tokens, transcript path. */
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
   * Directory for research transcripts: one JSONL file per research run
   * (model turns, tool calls, arguments, results). Absent → nothing is
   * written. The dir is set to 0700 (created or reused), files are 0600.
   */
  transcriptDir?: string;
  /** Optional sink for research lifecycle events (names and counts only). */
  onResearchEvent?: (event: ResearchEvent) => void;
}

// ---------------------------------------------------------------------------
// Run state — created by runPipeline, never host configuration
// ---------------------------------------------------------------------------

/** Not exported from the package: a host cannot name it, so it cannot set run state. */
const RUN_STATE = Symbol("pulse.runState");

export interface RunState {
  /** What each primitive's preflight returned, keyed by its step spec. */
  preflight: Map<object, unknown>;
  /** Models a research step found unreachable this run, with the reason. */
  unavailableModels: Map<string, string>;
}

/** The options for one run: the host's options plus fresh run state (object spread carries it into nested steps). */
export function withRunState(options: StepRunnerOptions): StepRunnerOptions {
  const state: RunState = { preflight: new Map(), unavailableModels: new Map() };
  return { ...options, [RUN_STATE]: state } as StepRunnerOptions;
}

/** The run state, or undefined when the steps are driven without runPipeline. */
export function runState(options: StepRunnerOptions): RunState | undefined {
  return (options as { [RUN_STATE]?: RunState })[RUN_STATE];
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
        throw new Error(`prompt template: payload has no field '${pathExpr}'`);
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  });
}
