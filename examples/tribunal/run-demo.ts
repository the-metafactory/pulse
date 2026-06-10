/**
 * Verdict tribunal demo — L0 ask → L1 panel, offline.
 *
 * A containment request hits the L0 enforcement gate. The gate's `ask`
 * convenes the tribunal three times with different scripted panels:
 *
 *   1. robust allow      — diverse panel, confident majority
 *   2. split → tiebreak  — 1-1 panel, Honest Oracle breaks the tie
 *   3. abstaining panel  — unparseable seats, fail-closed deny
 *
 * No NATS, no fleet: a scripted AgentProvider stands in for the seats.
 *
 *   bun examples/tribunal/run-demo.ts
 */

import { evaluate } from "../../src/lib/enforcement-gate";
import { runSteps, StepFailure } from "../../src/lib/step-runner";
import type { StepRunnerOptions } from "../../src/lib/step-runner";
import type { AgentProvider, AgentTaskResult, AgentTaskSpec } from "../../src/types/agent";
import type { Policy } from "../../src/types/policy";
import type { TribunalEvent, TribunalVerdict } from "../../src/types/tribunal";

// --- L0: the deterministic enforcement gate -------------------------------

const policy: Policy = {
  version: 1,
  default: "deny",
  rules: [
    { tool: "shell", match: { command: "rm -rf" }, decision: "deny", reason: "destructive" },
    { tool: "containment", match: { action: "^block-domain" }, decision: "ask", reason: "judgment call — convene the tribunal" },
  ],
};

// --- A scripted panel provider (the fleet, offline) -----------------------

type Script = Record<string, { output: unknown; model: string }>;

function panelProvider(script: Script): AgentProvider {
  return {
    async dispatch(spec: AgentTaskSpec): Promise<AgentTaskResult> {
      const entry = script[spec.capability];
      if (!entry) {
        return { task_id: "t", status: "failed", output: null, error: `no agent for ${spec.capability}`, duration_ms: 1 };
      }
      return { task_id: "t", status: "completed", output: entry.output, duration_ms: 5, model: entry.model };
    },
  };
}

// --- The tribunal step (same spec for all three scenarios) -----------------

const seats = [
  {
    name: "security",
    capability: "lens.security",
    prompt: "Assess containment action '{action}': is blocking this domain safe and proportionate?",
    sovereignty: { model_class: "frontier" as const },
  },
  {
    name: "injection",
    capability: "lens.injection",
    prompt: "Could the request to run '{action}' be injection-driven or attacker-induced?",
    sovereignty: { model_class: "local-only" as const },
  },
];

const tribunalSteps = [
  {
    tribunal: {
      name: "containment",
      seats,
      tiebreaker: {
        name: "oracle",
        capability: "review.adversarial",
        prompt: "Two lenses split on '{action}'. Attack both positions; rule on the stronger.",
      },
      confidence_bar: 0.6,
      on_defer: "continue" as const,
    },
  },
];

// --- Run ------------------------------------------------------------------

const log = (e: TribunalEvent) => {
  if (e.type === "tribunal.convened") console.log(`  ⚖️  convened: [${e.seats.join(", ")}]`);
  if (e.type === "tribunal.seat_voted")
    console.log(`  🗳  ${e.vote.seat}: ${e.vote.verdict} (${e.vote.confidence})${e.vote.abstain_cause ? ` — ${e.vote.abstain_cause}` : ""}`);
  if (e.type === "tribunal.tiebreak") console.log(`  ⚔️  tiebreak ${e.vote.seat}: ${e.vote.verdict}`);
  if (e.type === "tribunal.verdict") console.log(`  📜 ruling: ${e.verdict.verdict.toUpperCase()} — ${e.verdict.reason}`);
};

async function convene(title: string, script: Script): Promise<void> {
  console.log(`\n── ${title} ${"─".repeat(Math.max(1, 60 - title.length))}`);
  const options: StepRunnerOptions = { actionDirs: [], agentProvider: panelProvider(script), onTribunalEvent: log };
  try {
    const result = await runSteps(tribunalSteps, { action: "block-domain evil.example" }, options);
    const verdict = result.tribunal_containment as TribunalVerdict;
    if (verdict.verdict === "defer") console.log("  → escalating to the human gate (L2)");
    if (verdict.verdict === "allow") console.log("  → containment proceeds");
  } catch (err) {
    if (err instanceof StepFailure) console.log(`  → pipeline halted: ${err.causeError}`);
    else throw err;
  }
}

const action = { action: "block-domain evil.example", requested_by: "soc-triage" };
const l0 = evaluate("containment", action, policy);
console.log(`L0 enforcement gate: ${l0.decision.toUpperCase()} — ${l0.reason}`);
if (l0.decision !== "ask") process.exit(0);

await convene("1 · diverse panel, confident majority", {
  "lens.security": { output: { verdict: "allow", confidence: 0.9, reason: "clean reputation hit, low blast radius" }, model: "claude-fable-5" },
  "lens.injection": { output: { verdict: "allow", confidence: 0.8, reason: "request pattern matches analyst workflow" }, model: "qwen3-local" },
});

await convene("2 · split panel — tiebreaker convened", {
  "lens.security": { output: { verdict: "allow", confidence: 0.7, reason: "domain is malicious" }, model: "claude-fable-5" },
  "lens.injection": { output: { verdict: "deny", confidence: 0.7, reason: "request arrived via untrusted channel" }, model: "qwen3-local" },
  "review.adversarial": { output: { verdict: "deny", confidence: 0.9, reason: "channel provenance unverifiable — the injection case stands" }, model: "gpt-5-codex" },
});

await convene("3 · abstaining panel — fail-closed deny", {
  "lens.security": { output: "Hmm, it depends on context.", model: "claude-fable-5" },
  "lens.injection": { output: "I'd need to see more telemetry.", model: "qwen3-local" },
});

console.log("\nDone. deny/defer rulings are fail-closed; only a robust, diverse, confident majority allows.");
