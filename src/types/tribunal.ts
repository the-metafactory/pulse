/**
 * Verdict Tribunal Types — model-diverse agent panel adjudicating `ask` decisions.
 *
 * The tribunal is L1 of the governed-action stack: the L0 enforcement gate
 * (src/lib/enforcement-gate.ts) pre-filters with allow/ask/deny; an `ask`
 * convenes a tribunal of agent seats; only the tribunal's `defer` reaches the
 * human gate (L2). Concept: RavenClaude's command-review tribunal + model
 * diversity rule, rebuilt on the pulse agent/bus substrate. Fail-closed
 * discipline mirrors the Magnús Smárason enforcement-gate spec.
 *
 * See docs/verdict-tribunal.md for the aggregation table and design rationale.
 */

import type { AgentSovereignty } from "./agent";

// ---------------------------------------------------------------------------
// Seats — agent lenses on the panel
// ---------------------------------------------------------------------------

/**
 * One tribunal seat: a capability-addressed agent lens (security, code,
 * injection, adversarial/Honest Oracle, ...). Each seat is dispatched like an
 * `agent:` step and must answer with a structured vote.
 */
export interface SeatSpec {
  /** Stable identifier for this seat (used in votes + events). */
  name: string;
  /** Capability address the fleet routes on, e.g. "review.adversarial". */
  capability: string;
  /**
   * Seat prompt template. `{field}` / `{dotted.path}` placeholders are
   * rendered from payload context. The runner appends the vote-format
   * contract — seats must not be asked to invent their own output shape.
   */
  prompt: string;
  /** Sovereignty constraints for this seat's task envelope. */
  sovereignty?: AgentSovereignty;
  /** Per-seat timeout in milliseconds. Omit for the tribunal default. */
  timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// Votes & verdicts
// ---------------------------------------------------------------------------

/** What a seat may answer. `abstain` is also the fail-closed coercion target. */
export type SeatVerdict = "allow" | "deny" | "abstain";

/** The tribunal ruling. `defer` escalates to the human gate (L2). */
export type TribunalRuling = "allow" | "deny" | "defer";

export interface SeatVote {
  /** Seat name (SeatSpec.name), or the tiebreaker's name. */
  seat: string;
  verdict: SeatVerdict;
  /** Self-reported confidence in [0, 1]. Unparseable/missing → 0. */
  confidence: number;
  /** The seat's one-line justification ("" when none was given). */
  reason: string;
  /** Executing model identity, when the agent reported one. */
  model?: string;
  /** Why this vote is an abstain, when it was coerced (failure, timeout, parse). */
  abstain_cause?: string;
}

/** Diversity record — what the model-diversity rule saw and did. */
export interface TribunalDiversity {
  /** Declared model classes across the panel after any reassignment. */
  classes: string[];
  /** Name of the seat whose class was reassigned, when one was. */
  reassigned_seat?: string;
  /**
   * True when the panel is an all-local-only monoculture that sovereignty
   * forbids diversifying — an `allow` ruling is downgraded to `defer`.
   */
  unsatisfiable?: boolean;
  /** True when ≥2 seats reported the identical executing model post-hoc. */
  posthoc_monoculture?: boolean;
}

export interface TribunalVerdict {
  name: string;
  verdict: TribunalRuling;
  /** Deterministic explanation of how the ruling was reached. */
  reason: string;
  votes: SeatVote[];
  diversity: TribunalDiversity;
  /** Present when a tiebreaker was convened. */
  tiebreak?: SeatVote;
  convened_at: string;
  ruled_at: string;
}

// ---------------------------------------------------------------------------
// Step spec — the declarative `tribunal:` surface
// ---------------------------------------------------------------------------

export interface TribunalStepSpec {
  /** Stable identifier for this tribunal (used in events + traces). */
  name: string;
  /** Panel seats. At least one; diversity rule applies when ≥2. */
  seats: SeatSpec[];
  /** Convened once when the panel splits allow/deny evenly. */
  tiebreaker?: SeatSpec;
  /**
   * Minimum mean confidence of the allowing majority for an `allow` ruling.
   * Below the bar the ruling degrades to `defer`. Default: 0 (no bar).
   */
  confidence_bar?: number;
  /**
   * What a `defer` ruling does to the pipeline. Default "fail" raises
   * StepFailure (fail-closed — a pipeline must not run past an unresolved
   * judgment call). "continue" opts into downstream handling, e.g. a gate.
   */
  on_defer?: "fail" | "continue";
  /** Per-seat dispatch timeout in milliseconds (seat-level wins when set). */
  timeout_ms?: number;
  /** Field to write the TribunalVerdict under (default: `tribunal_${name}`). */
  collect?: string;
}

// ---------------------------------------------------------------------------
// Lifecycle events — host-observable, like GateEvent / AgentEvent
// ---------------------------------------------------------------------------

export type TribunalEvent =
  | { type: "tribunal.convened"; name: string; seats: string[]; convened_at: string }
  | { type: "tribunal.seat_voted"; name: string; vote: SeatVote }
  | { type: "tribunal.tiebreak"; name: string; vote: SeatVote }
  | { type: "tribunal.verdict"; name: string; verdict: TribunalVerdict };
