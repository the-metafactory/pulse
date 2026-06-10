/**
 * Enforcement gate types — the runtime complement to capability manifests.
 *
 * A manifest *declares* what an action may do; the gate *enforces* it at
 * call time. Spec authored by Magnús Smárason (Sumarhús), implemented here
 * on the pulse substrate. The whole point is the fail-closed invariant:
 * there is no path to `allow` that is not an explicit, matching rule.
 *
 * The decision core (src/lib/enforcement-gate.ts) is pure — no I/O, no
 * network, no mutation. Loading the policy and adapting to a host is the
 * caller's job (src/lib/policy-loader.ts).
 */

export type Decision = "allow" | "ask" | "deny";

/**
 * A single policy rule. Rules are evaluated top-to-bottom; first match wins.
 * An absent or invalid `decision` is coerced to `deny` (fail closed).
 */
export interface PolicyRule {
  /** Exact tool name, or "*" for any. Absent → "*". */
  tool?: string;
  /** Field→regex map. ALL fields must match for the rule to fire. */
  match?: Record<string, string>;
  /** Outcome when this rule matches. Absent/invalid → "deny". */
  decision?: Decision;
  /** Human-readable rationale, surfaced on non-allow. */
  reason?: string;
}

export interface Policy {
  version: number;
  /** Outcome when no rule matches. Absent → "deny" (fail closed). */
  default?: Decision;
  /** Ordered rules. Absent → [] (so every call falls through to default). */
  rules?: PolicyRule[];
}

export interface GateDecision {
  decision: Decision;
  reason: string;
  /** Index of the matching rule, or -1 when the policy default applied. */
  rule_index: number;
}
