/**
 * dev-loop pipeline definition — validation + round-trip tests.
 *
 * Proves the design §3.3 process definition is a REAL, validating pulse
 * artifact: it parses through the engine's actual loader (`loadPipeline`, which
 * runs `validateSteps`), exposes the expected D/A/H step shapes, and runs end to
 * end through `runPipelineFromYaml` with a scripted fleet + auto-gate — exactly
 * how the soc-triage / build-journal examples are exercised by their run scripts.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { loadPipeline, runPipelineFromYaml } from "../../src/lib/pipeline";
import { MockAgentProvider } from "../../src/lib/agent-provider";
import type { GateInput, GateProvider } from "../../src/types/pipeline";

const YAML = join(import.meta.dir, "pipeline.yaml");

/** Auto-approve the release gate (offline default — mirrors soc-triage). */
class AutoGateProvider implements GateProvider {
  async requestVerdict(_spec: { name: string; prompt: string }): Promise<GateInput> {
    return { verdict: "pass", notes: "auto-approved (test default)" };
  }
}

describe("dev-loop pipeline.yaml — validates through the real loader", () => {
  test("loadPipeline parses the definition and validates every step", async () => {
    const { pipeline } = await loadPipeline(YAML);
    expect(pipeline.name).toBe("P_DEV_LOOP");
    // 7 design-§3.3 stages: implement, review, A_DISPOSITION, A_MERGE_PRECHECK,
    // approve, release-decision gate, release.
    expect(pipeline.actions).toHaveLength(7);
  });

  test("steps map to the D/A/H taxonomy in the right order", async () => {
    const { pipeline } = await loadPipeline(YAML);
    const kinds = pipeline.actions.map((step) => {
      if (typeof step === "string") return `D:${step}`;
      const key = Object.keys(step)[0];
      const spec = (step as Record<string, any>)[key];
      return `${key}:${spec.name ?? ""}`;
    });
    expect(kinds).toEqual([
      "agent:implement",
      "agent:review",
      "D:A_DISPOSITION",
      "D:A_MERGE_PRECHECK",
      "agent:approve",
      "gate:release-decision",
      "agent:release",
    ]);
  });

  test("agent steps carry capability + sovereignty + offer distribution", async () => {
    const { pipeline } = await loadPipeline(YAML);
    const agents = pipeline.actions.filter(
      (s): s is { agent: any } => typeof s === "object" && "agent" in s,
    );
    const caps = agents.map((s) => s.agent.capability);
    expect(caps).toEqual(["dev.implement", "code-review.typescript", "merge.approve", "release.cut"]);
    for (const s of agents) {
      expect(s.agent.distribution_mode).toBe("offer");
      expect(s.agent.sovereignty?.classification).toBe("local");
      expect(typeof s.agent.timeout_ms).toBe("number");
    }
  });
});

describe("dev-loop pipeline.yaml — happy-path round-trip", () => {
  test("runs end to end with a scripted fleet + auto-gate", async () => {
    // One scripted result per capability the definition dispatches.
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 542, head_sha: "abc1234" },
      "code-review.typescript": { verdict: "approved", findings: [] },
      "merge.approve": { merged: true, merge_sha: "def5678" },
      "release.cut": { version: "v0.9.0", deployed: true },
    });

    const result = await runPipelineFromYaml(
      YAML,
      {
        slice: {
          id: "C-901.1",
          issue_ref: "cortex#901",
          design_ref: "docs/design-agentic-dev-pipeline.md §3.3",
          branch: "feat/c-901-dev-loop",
          gates: "tsc, lint, test, vocab",
        },
      },
      { agentProvider: provider, gateProvider: new AutoGateProvider() },
    );

    expect(result.success).toBe(true);

    // Every stage left its mark on the accumulated payload.
    const out = result.output as Record<string, any>;
    expect(out.implement.output.pr).toBe(542);
    expect(out.disposition.proceed).toBe(true);
    expect(out.disposition.counts.total).toBe(0);
    expect(out.precheck.ok).toBe(true);
    expect(out.approve.output.merged).toBe(true);
    expect(out.release_decision.verdict).toBe("pass");
    expect(out.release.output.version).toBe("v0.9.0");

    // The fleet was asked for exactly the four capabilities, in order.
    expect(provider.dispatched.map((d) => d.capability)).toEqual([
      "dev.implement",
      "code-review.typescript",
      "merge.approve",
      "release.cut",
    ]);
  });

  test("A_DISPOSITION classifies findings fix-small vs defer-big", async () => {
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 543, head_sha: "aaa" },
      "code-review.typescript": {
        verdict: "changes-requested",
        findings: [
          { id: "F1", severity: "high", summary: "null deref" },
          { id: "F2", severity: "low", summary: "rename for clarity", scope_expanding: true },
        ],
      },
      "merge.approve": { merged: true },
      "release.cut": { version: "v0.9.1" },
    });

    const result = await runPipelineFromYaml(
      YAML,
      { slice: { id: "C-901.2", issue_ref: "x", design_ref: "y", branch: "b", gates: "g" } },
      { agentProvider: provider, gateProvider: new AutoGateProvider() },
    );

    // Pipeline still succeeds (no engine branch on the verdict — gap G2): the
    // disposition is data, the fix-cycle is the driver's job.
    expect(result.success).toBe(true);
    const d = (result.output as Record<string, any>).disposition;
    expect(d.verdict).toBe("changes-requested");
    expect(d.proceed).toBe(false);
    expect(d.counts.fix_small).toBe(1); // the high-severity finding
    expect(d.counts.defer_big).toBe(1); // the scope-expanding low finding
  });

  test("A_DISPOSITION defaults absent/ambiguous findings to defer-big (conservative)", async () => {
    // The safe default: a medium/low finding the reviewer did NOT explicitly
    // affirm as contained (`scope_expanding === false`) goes to defer-big — it
    // does not bloat the fix-cycle. blocking/high always fix-small regardless.
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 545, head_sha: "bbb" },
      "code-review.typescript": {
        verdict: "changes-requested",
        findings: [
          { id: "A", severity: "low" },                         // absent flag → defer-big
          { id: "B", severity: "medium", scope_expanding: false }, // opt-in    → fix-small
          { id: "C", severity: "blocking" },                    // severity    → fix-small
          { id: "D" },                                          // no severity → defer-big
        ],
      },
      "merge.approve": { merged: true },
      "release.cut": { version: "v0.9.3" },
    });

    const result = await runPipelineFromYaml(
      YAML,
      { slice: { id: "C-901.4", issue_ref: "x", design_ref: "y", branch: "b", gates: "g" } },
      { agentProvider: provider, gateProvider: new AutoGateProvider() },
    );

    expect(result.success).toBe(true);
    const d = (result.output as Record<string, any>).disposition;
    expect(d.counts.fix_small).toBe(2); // B (opt-in) + C (blocking)
    expect(d.counts.defer_big).toBe(2); // A (absent flag) + D (no severity)
    expect(d.fix_small.map((f: any) => f.id).sort()).toEqual(["B", "C"]);
    expect(d.defer_big.map((f: any) => f.id).sort()).toEqual(["A", "D"]);
  });

  test("A_MERGE_PRECHECK emits ok=false and reason on CI failure", async () => {
    // The precheck only emits DATA — the engine cannot branch on ok=false
    // (gap G2), so merge.approve still runs and the pipeline still succeeds.
    // That is exactly why a failing-precheck test is valuable: it documents
    // that the precheck is advisory until a conditional construct exists.
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 546, head_sha: "ccc" },
      "code-review.typescript": { verdict: "approved", findings: [] },
      "merge.approve": { merged: true },
      "release.cut": { version: "v0.9.4" },
    });

    const result = await runPipelineFromYaml(
      YAML,
      {
        slice: { id: "C-901.5", issue_ref: "x", design_ref: "y", branch: "b", gates: "g" },
        // Injected merge state: CI failed, mergeable, not stale.
        merge_state: { ci_conclusion: "failure", mergeable: true, behind_by: 0 },
      },
      { agentProvider: provider, gateProvider: new AutoGateProvider() },
    );

    expect(result.success).toBe(true);
    const out = result.output as Record<string, any>;
    expect(out.precheck.ok).toBe(false);
    expect(out.precheck.checks).toEqual({ ci_green: false, mergeable: true, fresh: true });
    expect(out.precheck.reason).toContain("CI not green");
    // The precheck did NOT greenlight, yet merge.approve still ran (gap G2).
    expect(provider.dispatched.map((p) => p.capability)).toContain("merge.approve");
  });

  test("A_MERGE_PRECHECK composes a multi-cause reason on stale + unmergeable head", async () => {
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 547 },
      "code-review.typescript": { verdict: "approved", findings: [] },
      "merge.approve": { merged: true },
      "release.cut": { version: "v0.9.5" },
    });

    const result = await runPipelineFromYaml(
      YAML,
      {
        slice: { id: "C-901.6", issue_ref: "x", design_ref: "y", branch: "b", gates: "g" },
        merge_state: { ci_conclusion: "success", mergeable: false, behind_by: 3 },
      },
      { agentProvider: provider, gateProvider: new AutoGateProvider() },
    );

    expect(result.success).toBe(true);
    const pre = (result.output as Record<string, any>).precheck;
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain("not MERGEABLE");
    expect(pre.reason).toContain("stale: base ahead by 3");
  });

  test("a held release gate (verdict=fail) stops before release.cut", async () => {
    class HoldGate implements GateProvider {
      async requestVerdict(): Promise<GateInput> {
        return { verdict: "fail", notes: "hold the release" };
      }
    }
    const provider = new MockAgentProvider({
      "dev.implement": { pr: 544 },
      "code-review.typescript": { verdict: "approved", findings: [] },
      "merge.approve": { merged: true },
      "release.cut": { version: "v0.9.2" },
    });

    const result = await runPipelineFromYaml(
      YAML,
      { slice: { id: "C-901.3", issue_ref: "x", design_ref: "y", branch: "b", gates: "g" } },
      { agentProvider: provider, gateProvider: new HoldGate() },
    );

    expect(result.success).toBe(false);
    // release.cut must NOT have been dispatched — the gate held the line.
    expect(provider.dispatched.map((d) => d.capability)).not.toContain("release.cut");
  });
});
