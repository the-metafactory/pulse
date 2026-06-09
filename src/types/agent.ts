/**
 * Agent Task Types — LLM/agent tasks as first-class Pulse steps.
 *
 * An agent task is a capability-addressed, sovereignty-constrained transform:
 * payload in, payload out, executed by whichever fleet agent claims the task.
 * Pulse never talks to agents directly — it asks the bus (myelin envelopes
 * over NATS) and awaits the dispatch lifecycle. See docs/agent-actions.md.
 *
 * Sovereignty vocabulary mirrors the myelin v3 envelope schema
 * (myelin: schemas/envelope.schema.json). Pulse declares the constraints;
 * the bus and the fleet enforce them.
 */

// ---------------------------------------------------------------------------
// Sovereignty — policy that travels with the task
// ---------------------------------------------------------------------------

export interface AgentSovereignty {
  /** Envelope classification. Default: "local" (never leaves the principal). */
  classification?: "local" | "federated" | "public";
  /** ISO 3166-1 alpha-2 country code for data residency (e.g. "CH"). */
  data_residency?: string;
  /** Federation hop limit. 0 = origin only. */
  max_hop?: number;
  /** May a frontier (cloud) model see this payload? */
  frontier_ok?: boolean;
  /** Which model class may execute: confidential data → "local-only". */
  model_class?: "local-only" | "frontier" | "any";
}

// ---------------------------------------------------------------------------
// Task spec & result — what dispatch sends and what comes back
// ---------------------------------------------------------------------------

export interface AgentTaskSpec {
  /** Capability address, e.g. "soc.triage.email". The fleet routes on this. */
  capability: string;
  /** The work request — natural-language instruction for the agent. */
  prompt: string;
  /** Optional structured input published alongside the prompt. */
  input?: Record<string, unknown>;
  /** Sovereignty constraints. Defaults applied by the provider. */
  sovereignty?: AgentSovereignty;
  /** Routing semantics (myelin F-021). Default: "offer" (competing consumers). */
  distribution_mode?: "offer" | "direct" | "delegate";
  /** DID of the receiving assistant. Required for direct/delegate. */
  target_assistant?: string;
  /** Soft deadline forwarded into the envelope, milliseconds from dispatch. */
  timeout_ms?: number;
}

export interface AgentTaskResult {
  task_id: string;
  status: "completed" | "failed";
  /** The agent's result payload (shape is capability-specific). */
  output: unknown;
  error?: string;
  duration_ms: number;
  /** Identity of the executing agent, when reported. */
  agent?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ---------------------------------------------------------------------------
// Provider — pluggable dispatch, mirroring the GateProvider precedent
// ---------------------------------------------------------------------------

/**
 * Pluggable agent dispatcher. The runner owns timeouts — providers receive
 * only an AbortSignal and MUST reject the returned promise when it fires
 * (same contract as GateProvider; see docs/adr and P-304 decision log).
 *
 * dispatch() resolves with the task result (status "completed" or "failed");
 * it rejects only on transport errors and aborts. Step-level semantics
 * (raising StepFailure on status "failed") belong to the runner.
 */
export interface AgentProvider {
  dispatch(spec: AgentTaskSpec, opts?: { signal?: AbortSignal }): Promise<AgentTaskResult>;
}

// ---------------------------------------------------------------------------
// Lifecycle events — host-observable, like GateEvent
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent.dispatched"; name: string; capability: string; task_id: string; dispatched_at: string }
  | { type: "agent.completed"; name: string; capability: string; task_id: string; duration_ms: number }
  | { type: "agent.failed"; name: string; capability: string; task_id: string; error: string }
  | { type: "agent.timeout"; name: string; capability: string; task_id: string; timeout_ms: number };

// ---------------------------------------------------------------------------
// Pipeline step spec — the declarative `agent:` surface
// ---------------------------------------------------------------------------

/**
 * Declarative agent step. Completes miner's D/A/H step taxonomy in pipeline
 * YAML: Deterministic = action, Agentic = `agent:`, Human = `gate:`.
 */
export interface AgentStepSpec {
  /** Stable identifier for this step (used in events + traces). */
  name: string;
  /** Capability address the fleet routes on. */
  capability: string;
  /**
   * Prompt template. `{field}` and `{dotted.path}` placeholders are rendered
   * from payload context before dispatch; object values are JSON-encoded.
   */
  prompt: string;
  /** Sovereignty constraints carried in the task envelope. */
  sovereignty?: AgentSovereignty;
  /** Routing semantics. Default: "offer". */
  distribution_mode?: "offer" | "direct" | "delegate";
  /** DID of receiving assistant. Required for direct/delegate. */
  target_assistant?: string;
  /** Optional timeout in milliseconds. Omit for indefinite wait. */
  timeout_ms?: number;
  /** Field to write the AgentTaskResult under (default: `agent_${name}`). */
  collect?: string;
}
