/**
 * Governed step primitive tests — the L0→L1→L2 layered stack routing table:
 * allow skips the panel, deny is terminal at every layer, ask convenes the
 * tribunal (or degrades to the gate), defer escalates to the human, and
 * every joint fails closed.
 */

import { describe, test, expect } from "bun:test";
import { runSteps, validateStep, StepFailure } from "../src/lib/step-runner";
import type { StepRecord, StepRunnerOptions } from "../src/lib/step-runner";
import type { AgentDispatchOptions, AgentProvider, AgentTaskResult, AgentTaskSpec } from "../src/types/agent";
import type { GateInput, GateProvider } from "../src/types/pipeline";
import type { GovernedEvent, GovernedResult, GovernedStepSpec } from "../src/types/governed";
import type { Policy } from "../src/types/policy";

function options(overrides: Partial<StepRunnerOptions> = {}): StepRunnerOptions {
  return { actionDirs: [], ...overrides };
}

const POLICY: Policy = {
  version: 1,
  default: "deny",
  rules: [
    { tool: "containment", match: { action: "^pre-approved$" }, decision: "allow", reason: "sinkhole pattern" },
    { tool: "containment", match: { action: "^forbidden$" }, decision: "deny", reason: "protected zone" },
    { tool: "containment", match: { action: "^judgment$" }, decision: "ask", reason: "convene the panel" },
  ],
};

/** Scripted panel: capability → vote object. Counts dispatches. */
class Panel implements AgentProvider {
  public dispatched: AgentTaskSpec[] = [];
  constructor(private votes: Record<string, unknown>) {}
  async dispatch(spec: AgentTaskSpec, _opts: AgentDispatchOptions = {}): Promise<AgentTaskResult> {
    this.dispatched.push(spec);
    return {
      task_id: "t",
      status: "completed",
      output: this.votes[spec.capability],
      duration_ms: 1,
      model: `model-${spec.capability}`,
    };
  }
}

class ScriptedGate implements GateProvider {
  public prompts: string[] = [];
  constructor(private input: GateInput) {}
  async requestVerdict(spec: { name: string; prompt: string }): Promise<GateInput> {
    this.prompts.push(spec.prompt);
    return this.input;
  }
}

const seats = [
  { name: "a", capability: "lens.a", prompt: "Vote on {action}", sovereignty: { model_class: "frontier" as const, frontier_ok: true } },
  { name: "b", capability: "lens.b", prompt: "Vote on {action}", sovereignty: { model_class: "local-only" as const } },
];

const allow = (c = 0.9) => ({ verdict: "allow", confidence: c, reason: "fine" });
const deny = (c = 0.9) => ({ verdict: "deny", confidence: c, reason: "risky" });

function governedStep(spec: Partial<GovernedStepSpec> & Record<string, unknown> = {}) {
  return [
    {
      governed: {
        name: "g",
        tool: "containment",
        input_fields: ["action", "targets"],
        policy: POLICY,
        ...spec,
      },
    },
  ];
}

describe("governed — L0 routing", () => {
  test("L0 allow continues immediately — the panel is never dispatched", async () => {
    const panel = new Panel({});
    const result = await runSteps(
      governedStep({ tribunal: { name: "panel", seats } }),
      { action: "pre-approved", keep: 1 },
      options({ agentProvider: panel }),
    );
    const g = result.governed_g as GovernedResult;
    expect(g.outcome).toBe("allow");
    expect(g.resolved_by).toBe("policy");
    expect(g.l0.decision).toBe("allow");
    expect(g.tribunal).toBeUndefined();
    expect(panel.dispatched).toHaveLength(0); // zero LLM cost
    expect(result.keep).toBe(1); // passthrough preserved
  });

  test("L0 deny halts with the rule reason — tribunal never convened", async () => {
    const panel = new Panel({});
    const records: StepRecord[] = [];
    await expect(
      runSteps(
        governedStep({ tribunal: { name: "panel", seats } }),
        { action: "forbidden" },
        options({ agentProvider: panel }),
        records,
      ),
    ).rejects.toThrow(/L0 deny — protected zone/);
    expect(panel.dispatched).toHaveLength(0);
    const rec = records.find((r) => r.action === "governed:g");
    expect(rec?.governed?.outcome).toBe("deny");
    expect(rec?.governed?.resolved_by).toBe("policy");
  });

  test("malformed policy denies fail-closed through the step", async () => {
    await expect(
      runSteps(
        governedStep({ policy: { version: 1, rules: "not-an-array" } as unknown as Policy }),
        { action: "anything" },
        options(),
      ),
    ).rejects.toThrow(/L0 deny/);
  });

  test("missing input field does not crash — policy default decides", async () => {
    // 'action' absent from payload: no rule matches, default deny.
    await expect(
      runSteps(governedStep(), { unrelated: true }, options()),
    ).rejects.toThrow(/L0 deny/);
  });
});

describe("governed — L1 routing", () => {
  test("ask convenes the tribunal; tribunal allow resolves", async () => {
    const panel = new Panel({ "lens.a": allow(), "lens.b": allow(0.8) });
    const result = await runSteps(
      governedStep({ tribunal: { name: "panel", seats } }),
      { action: "judgment" },
      options({ agentProvider: panel }),
    );
    const g = result.governed_g as GovernedResult;
    expect(g.outcome).toBe("allow");
    expect(g.resolved_by).toBe("tribunal");
    expect(g.l0.decision).toBe("ask");
    expect(g.tribunal?.verdict).toBe("allow");
    expect(panel.dispatched).toHaveLength(2);
  });

  test("tribunal deny is terminal — no gate appeal even when a gate is configured", async () => {
    const panel = new Panel({ "lens.a": deny(), "lens.b": deny() });
    const gate = new ScriptedGate({ verdict: "pass", notes: "would have approved" });
    const records: StepRecord[] = [];
    await expect(
      runSteps(
        governedStep({ tribunal: { name: "panel", seats }, gate: { name: "analyst" } }),
        { action: "judgment" },
        options({ agentProvider: panel, gateProvider: gate }),
        records,
      ),
    ).rejects.toThrow(/majority deny/);
    expect(gate.prompts).toHaveLength(0); // refusals never reach the human
    const rec = records.find((r) => r.action === "governed:g");
    expect(rec?.governed?.resolved_by).toBe("tribunal");
    expect(rec?.governed?.tribunal?.verdict).toBe("deny");
  });

  test("Anti: ask with neither tribunal nor gate fails closed", async () => {
    await expect(
      runSteps(governedStep(), { action: "judgment" }, options()),
    ).rejects.toThrow(/no gate configured, failing closed/);
  });
});

describe("governed — L2 routing", () => {
  // Split panel with no tiebreaker → defer → gate.
  const splitVotes = { "lens.a": allow(0.7), "lens.b": deny(0.7) };

  test("tribunal defer opens the gate; gate pass allows — all three verdicts present", async () => {
    const panel = new Panel(splitVotes);
    const gate = new ScriptedGate({ verdict: "pass", notes: "analyst approves" });
    const result = await runSteps(
      governedStep({ tribunal: { name: "panel", seats }, gate: { name: "analyst" } }),
      { action: "judgment" },
      options({ agentProvider: panel, gateProvider: gate }),
    );
    const g = result.governed_g as GovernedResult;
    // The plan's acceptance: one run traverses all three layers.
    expect(g.l0.decision).toBe("ask");
    expect(g.tribunal?.verdict).toBe("defer");
    expect(g.gate?.verdict).toBe("pass");
    expect(g.outcome).toBe("allow");
    expect(g.resolved_by).toBe("gate");
    // The gate prompt carries the escalation reason.
    expect(gate.prompts[0]).toMatch(/tribunal defer/);
  });

  test("gate fail halts with the analyst notes", async () => {
    const panel = new Panel(splitVotes);
    const gate = new ScriptedGate({ verdict: "fail", notes: "wait for IR to finish resets" });
    const records: StepRecord[] = [];
    await expect(
      runSteps(
        governedStep({ tribunal: { name: "panel", seats }, gate: { name: "analyst" } }),
        { action: "judgment" },
        options({ agentProvider: panel, gateProvider: gate }),
        records,
      ),
    ).rejects.toThrow(/wait for IR to finish resets/);
    const rec = records.find((r) => r.action === "governed:g");
    expect(rec?.governed?.resolved_by).toBe("gate");
    expect(rec?.governed?.outcome).toBe("deny");
  });

  test("Anti: defer with no gate configured fails closed", async () => {
    const panel = new Panel(splitVotes);
    await expect(
      runSteps(
        governedStep({ tribunal: { name: "panel", seats } }),
        { action: "judgment" },
        options({ agentProvider: panel }),
      ),
    ).rejects.toThrow(/no gate configured, failing closed/);
  });

  test("ask with no tribunal but a gate degrades to the human directly", async () => {
    const panel = new Panel({});
    const gate = new ScriptedGate({ verdict: "pass", notes: "human says yes" });
    const result = await runSteps(
      governedStep({ gate: { name: "analyst" } }),
      { action: "judgment" },
      options({ agentProvider: panel, gateProvider: gate }),
    );
    const g = result.governed_g as GovernedResult;
    expect(g.resolved_by).toBe("gate");
    expect(g.tribunal).toBeUndefined();
    expect(panel.dispatched).toHaveLength(0);
    expect(gate.prompts[0]).toMatch(/policy ask/);
  });
});

describe("governed — mechanics", () => {
  test("custom collect; governed + tribunal + gate step records all present", async () => {
    const panel = new Panel({ "lens.a": allow(0.7), "lens.b": deny(0.7) });
    const gate = new ScriptedGate({ verdict: "pass", notes: "ok" });
    const records: StepRecord[] = [];
    const result = await runSteps(
      governedStep({ collect: "ruling", tribunal: { name: "panel", seats }, gate: { name: "analyst" } }),
      { action: "judgment" },
      options({ agentProvider: panel, gateProvider: gate }),
      records,
    );
    expect((result.ruling as GovernedResult).outcome).toBe("allow");
    const actions = records.map((r) => r.action);
    expect(actions).toContain("governed:g");
    expect(actions).toContain("tribunal:panel");
    expect(actions).toContain("gate:analyst");
  });

  test("lifecycle events: l0 → escalated(tribunal) → escalated(gate) → resolved", async () => {
    const panel = new Panel({ "lens.a": allow(0.7), "lens.b": deny(0.7) });
    const gate = new ScriptedGate({ verdict: "pass", notes: "ok" });
    const events: GovernedEvent[] = [];
    await runSteps(
      governedStep({ tribunal: { name: "panel", seats }, gate: { name: "analyst" } }),
      { action: "judgment" },
      options({ agentProvider: panel, gateProvider: gate, onGovernedEvent: (e) => events.push(e) }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "governed.l0",
      "governed.escalated",
      "governed.escalated",
      "governed.resolved",
    ]);
    const escalations = events.filter((e) => e.type === "governed.escalated") as Extract<GovernedEvent, { type: "governed.escalated" }>[];
    expect(escalations[0].to).toBe("tribunal");
    expect(escalations[1].to).toBe("gate");
  });

  test("retry composes around governed — L0 evaluated per attempt", async () => {
    const events: GovernedEvent[] = [];
    const steps = [
      {
        retry: {
          attempts: 2,
          backoff: "constant" as const,
          initial_delay_ms: 1,
          actions: governedStep(),
        },
      },
    ];
    await expect(
      runSteps(steps, { action: "forbidden" }, options({ onGovernedEvent: (e) => events.push(e) })),
    ).rejects.toThrow(StepFailure);
    expect(events.filter((e) => e.type === "governed.l0")).toHaveLength(2);
  });
});

describe("governed — validation", () => {
  const valid = {
    name: "g",
    tool: "t",
    input_fields: ["a"],
    policy: { version: 1, default: "deny" },
  };

  test("accepts a well-formed governed step", () => {
    expect(() =>
      validateStep({
        governed: {
          ...valid,
          tribunal: { name: "p", seats: [{ name: "s", capability: "c", prompt: "x" }] },
          gate: { name: "analyst", timeout_ms: 1000 },
        },
      }),
    ).not.toThrow();
  });

  test("rejects missing tool / input_fields / policy with path-qualified errors", () => {
    expect(() => validateStep({ governed: { ...valid, tool: undefined } })).toThrow(/'tool'/);
    expect(() => validateStep({ governed: { ...valid, input_fields: [] } })).toThrow(/input_fields/);
    expect(() => validateStep({ governed: { ...valid, policy: undefined } })).toThrow(/'policy'/);
  });

  test("rejects malformed tribunal and gate sub-specs", () => {
    expect(() => validateStep({ governed: { ...valid, tribunal: { name: "p", seats: [] } } })).toThrow(
      /tribunal.*non-empty array/,
    );
    expect(() => validateStep({ governed: { ...valid, gate: { name: "" } } })).toThrow(/gate.*'name'/);
  });
});
