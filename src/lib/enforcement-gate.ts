/**
 * Enforcement gate — the pure decision core.
 *
 * `evaluate(toolName, toolInput, policy) → GateDecision`, first-match-wins,
 * fail-closed. No I/O, no network, no mutation: loading the policy and
 * adapting to a host (capability wrapper, hook, CLI) is the caller's job.
 *
 * Spec: Magnús Smárason / Sumarhús, enforcement-gate/SPEC.md v1. The
 * fail-closed invariants below are the spec — the test suite proves them.
 */

import type { Decision, GateDecision, Policy, PolicyRule } from "../types/policy";

const VALID_DECISIONS = new Set<Decision>(["allow", "ask", "deny"]);

// Compile each match pattern once. The gate runs on every guarded capability
// call but policies are loaded once at startup, so the pattern set is tiny and
// stable — caching turns per-call regex compilation into a map lookup. An
// invalid pattern throws (uncached) and evaluate() turns the throw into a deny,
// every call, consistently.
const regexCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern); // throws on an invalid pattern — caller turns it into a deny
    regexCache.set(pattern, re);
  }
  return re;
}

/** Coerce an absent/invalid decision to "deny" — the fail-closed core move. */
function coerceDecision(value: unknown): Decision {
  return typeof value === "string" && VALID_DECISIONS.has(value as Decision)
    ? (value as Decision)
    : "deny";
}

/** Serialize a non-string field value for regex matching (objects → JSON). */
function fieldToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise non-serializable — treat as non-matchable, never throw.
    return "";
  }
}

/**
 * A rule matches iff: (a) rule.tool is "*" or equals toolName; AND (b) for
 * every field:regex in rule.match, the field is present in toolInput and the
 * regex matches its string form. An unparseable regex makes the rule deny
 * (handled by the caller catching the throw) — never a silent skip.
 */
function ruleMatches(rule: PolicyRule, toolName: string, toolInput: Record<string, unknown>): boolean {
  const tool = rule.tool ?? "*";
  if (tool !== "*" && tool !== toolName) return false;

  if (rule.match) {
    for (const [field, pattern] of Object.entries(rule.match)) {
      if (!(field in toolInput)) return false;
      // An invalid regex throws here; evaluate() turns that into a deny.
      const re = compile(pattern);
      if (!re.test(fieldToString(toolInput[field]))) return false;
    }
  }
  return true;
}

/**
 * Evaluate a tool call against a policy. Pure and total: every path returns a
 * decision, and every ambiguous case resolves to "deny".
 *
 * Algorithm (normative, SPEC.md §Algorithm):
 *   1. Empty/non-string toolName → deny.
 *   2. Non-object policy → deny (a failed load is the caller's deny already).
 *   3. First matching rule wins (absent/invalid decision coerced to deny).
 *   4. No match → policy default (absent → deny).
 */
export function evaluate(
  toolName: unknown,
  toolInput: unknown,
  policy: Policy | null | undefined,
): GateDecision {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { decision: "deny", reason: "tool name missing or not a string", rule_index: -1 };
  }
  if (!policy || typeof policy !== "object") {
    return { decision: "deny", reason: "policy missing or malformed", rule_index: -1 };
  }
  // rules may be absent (→ falls through to default) but a present non-array
  // rules field is malformed → deny. Clearer than the `?? []` form: this
  // rejects only the genuinely-wrong case, never the legitimately-absent one.
  if (policy.rules !== undefined && !Array.isArray(policy.rules)) {
    return { decision: "deny", reason: "policy.rules is not an array", rule_index: -1 };
  }

  const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
  const rules = policy.rules ?? [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    try {
      if (ruleMatches(rule, toolName, input)) {
        const decision = coerceDecision(rule.decision);
        return {
          decision,
          reason: rule.reason ?? `matched rule ${i} (${decision})`,
          rule_index: i,
        };
      }
    } catch (_err) {
      // Unparseable regex or any error while evaluating a rule → deny.
      // Errors close: a matcher that can't be evaluated must never wave through.
      return {
        decision: "deny",
        reason: `rule ${i} evaluation error — failing closed`,
        rule_index: i,
      };
    }
  }

  const fallback = coerceDecision(policy.default);
  return {
    decision: fallback,
    reason: policy.default ? `policy default (${fallback})` : "no rule matched; default deny",
    rule_index: -1,
  };
}
