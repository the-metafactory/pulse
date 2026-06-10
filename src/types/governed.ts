/**
 * Governed Action Types — the layered L0→L1→L2 stack as one pipeline step.
 *
 * One `governed:` block declares a consequential action's whole governance:
 * the deterministic policy (L0, enforcement-gate), the agent panel (L1,
 * tribunal), and the human gate (L2). Routing is monotone descent in
 * certainty — only what a layer cannot settle travels down; refusals are
 * terminal at every layer:
 *
 *   L0 evaluate()   allow → proceed (panel skipped — zero LLM cost)
 *                   deny  → halt (refusal is final)
 *                   ask   → L1 (or straight to L2 when no tribunal is set)
 *   L1 tribunal     allow → proceed · deny → halt · defer → L2
 *   L2 gate         pass  → proceed · fail → halt
 *
 * `ask` with neither tribunal nor gate configured fails closed. The primitive
 * COMPOSES the three existing mechanisms — pure evaluate(), the tribunal
 * runner, the gate runner — it never reimplements them.
 *
 * Stage 4 (P-702) of the governance upgrade plan; see docs/verdict-tribunal.md.
 */

import type { Policy, GateDecision } from "./policy";
import type { GateStepSpec, GateResult } from "./pipeline";
import type { TribunalStepSpec, TribunalVerdict } from "./tribunal";

/** The L1 panel config inside a governed step — a tribunal spec without its
 * own collect (the governed step owns the payload surface). */
export type GovernedTribunalSpec = Omit<TribunalStepSpec, "collect" | "on_defer">;

/** The L2 gate config inside a governed step. `prompt` may be omitted — the
 * runner derives it from the escalation reason when absent. */
export type GovernedGateSpec = Omit<GateStepSpec, "collect" | "prompt"> & { prompt?: string };

export interface GovernedStepSpec {
  /** Stable identifier for this governed action (events + traces). */
  name: string;
  /** Tool name the policy rules match on (enforcement-gate vocabulary). */
  tool: string;
  /**
   * Payload fields copied into the L0 toolInput. Absent payload fields are
   * omitted — a rule matching on a missing field simply doesn't match, and
   * the policy default (fail-closed) decides.
   */
  input_fields: string[];
  /** Inline enforcement-gate policy (first-match-wins, fail-closed). */
  policy: Policy;
  /** L1 panel. Omit to route `ask` straight to the gate (L0→L2). */
  tribunal?: GovernedTribunalSpec;
  /** L2 human gate. Omit only when the tribunal is expected to settle everything. */
  gate?: GovernedGateSpec;
  /** Field to write the GovernedResult under (default: `governed_${name}`). */
  collect?: string;
}

export interface GovernedResult {
  name: string;
  /** Final outcome. Every path ends allow or deny — no unhandled state. */
  outcome: "allow" | "deny";
  /** Which layer settled it. */
  resolved_by: "policy" | "tribunal" | "gate";
  /** The L0 decision (always present — every governed action is evaluated). */
  l0: GateDecision;
  /** Present when the panel was convened. */
  tribunal?: TribunalVerdict;
  /** Present when the human gate was opened. */
  gate?: GateResult;
  evaluated_at: string;
  resolved_at: string;
}

export type GovernedEvent =
  | { type: "governed.l0"; name: string; tool: string; decision: GateDecision; evaluated_at: string }
  | { type: "governed.escalated"; name: string; to: "tribunal" | "gate"; reason: string }
  | { type: "governed.resolved"; name: string; result: GovernedResult };
