/**
 * Flow — the top-level orchestrator in the Action/Pipeline/Flow triad.
 *
 * A flow connects a data source to a pipeline and writes the result
 * to a destination. Flows can run once, on a schedule, or on a trigger.
 *
 * From Daniel Miessler's PAI Arbol vision:
 *   Source → Pipeline → Destination (on a schedule)
 */

// ---------------------------------------------------------------------------
// Source — where data comes from
// ---------------------------------------------------------------------------

export type FlowSource =
  | { type: "rss"; url: string; limit?: number }
  | { type: "webhook"; path: string }
  | { type: "file"; path: string; watch?: boolean }
  | { type: "inline"; data: Record<string, unknown> }
  | { type: "custom"; fn: () => Promise<Record<string, unknown>> };

// ---------------------------------------------------------------------------
// Destination — where results go
// ---------------------------------------------------------------------------

export type FlowDestination =
  | { type: "file"; path: string; format?: "json" | "markdown" }
  | { type: "stdout" }
  | { type: "webhook"; url: string; method?: string; headers?: Record<string, string> }
  | { type: "custom"; fn: (output: Record<string, unknown>) => Promise<void> };

// ---------------------------------------------------------------------------
// Schedule — when the flow runs
// ---------------------------------------------------------------------------

export interface FlowSchedule {
  /** Cron expression (e.g. "0 *\/6 * * *" for every 6 hours) */
  cron?: string;
  /** Simple interval in seconds */
  intervalSeconds?: number;
}

// ---------------------------------------------------------------------------
// Flow Definition
// ---------------------------------------------------------------------------

export interface FlowDef {
  /** Flow name (e.g. "F_RSS_DIGEST") */
  name: string;
  /** Optional description */
  description?: string;
  /** Where data comes from */
  source: FlowSource;
  /** Pipeline name or inline pipeline definition */
  pipeline: string | { actions: string[] };
  /** Where results go */
  destination: FlowDestination;
  /** When to run (omit for single run) */
  schedule?: FlowSchedule;
  /** Additional static input merged with source data */
  input?: Record<string, unknown>;
  /** Execution mode */
  mode?: "local" | "cloud";
}

// ---------------------------------------------------------------------------
// Flow Execution Result
// ---------------------------------------------------------------------------

export interface FlowResult {
  flowName: string;
  success: boolean;
  /** Source fetch result */
  sourceData?: Record<string, unknown>;
  /** Pipeline execution result */
  pipelineOutput?: Record<string, unknown>;
  /** Destination write result */
  destinationWritten: boolean;
  /** Error if any stage failed */
  error?: string;
  /** Which stage failed */
  failedStage?: "source" | "pipeline" | "destination";
  /** Timing */
  durationMs: number;
  /** When this run completed */
  completedAt: string;
}
