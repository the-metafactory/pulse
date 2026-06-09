/**
 * Agent step primitive tests — declarative `agent:` steps in pipelines:
 * template rendering, collect semantics, failure propagation, timeout,
 * retry composition, lifecycle events, and validation.
 */

import { describe, test, expect } from "bun:test";
import { runSteps, validateStep, StepFailure } from "../src/lib/step-runner";
import type { StepRecord, StepRunnerOptions } from "../src/lib/step-runner";
import { MockAgentProvider } from "../src/lib/agent-provider";
import { renderPromptTemplate } from "../src/lib/primitive-runner";
import type { AgentEvent, AgentProvider, AgentTaskResult, AgentTaskSpec } from "../src/types/agent";

function options(overrides: Partial<StepRunnerOptions> = {}): StepRunnerOptions {
  return { actionDirs: [], ...overrides };
}

describe("renderPromptTemplate", () => {
  test("renders flat and dotted paths", () => {
    const out = renderPromptTemplate("Check {name} from {meta.source}", {
      name: "mail-1",
      meta: { source: "inbox" },
    });
    expect(out).toBe("Check mail-1 from inbox");
  });

  test("JSON-encodes object values", () => {
    const out = renderPromptTemplate("IOCs: {iocs}", { iocs: { urls: ["http://evil.test"] } });
    expect(out).toContain('"urls"');
    expect(out).toContain("http://evil.test");
  });

  test("throws on missing field", () => {
    expect(() => renderPromptTemplate("{missing}", {})).toThrow(/no field 'missing'/);
  });
});

describe("agent step", () => {
  test("dispatches rendered prompt, merges result under default collect field", async () => {
    const provider = new MockAgentProvider({
      "soc.triage.email": { verdict: "phishing", confidence: 0.95 },
    });
    const steps = [
      {
        agent: {
          name: "triage",
          capability: "soc.triage.email",
          prompt: "Analyze: {email}",
        },
      },
    ];

    const result = await runSteps(steps, { email: "click here", keep: 1 }, options({ agentProvider: provider }));

    expect(provider.dispatched[0].prompt).toBe("Analyze: click here");
    const collected = result.agent_triage as AgentTaskResult;
    expect(collected.status).toBe("completed");
    expect(collected.output).toEqual({ verdict: "phishing", confidence: 0.95 });
    expect(result.keep).toBe(1); // passthrough preserved
  });

  test("collect override writes to named field", async () => {
    const provider = new MockAgentProvider({ "soc.triage.email": "ok" });
    const steps = [
      { agent: { name: "triage", capability: "soc.triage.email", prompt: "x", collect: "triage" } },
    ];
    const result = await runSteps(steps, {}, options({ agentProvider: provider }));
    expect((result.triage as AgentTaskResult).output).toBe("ok");
  });

  test("sovereignty constraints are forwarded to the provider", async () => {
    const provider = new MockAgentProvider({ "soc.triage.email": "ok" });
    const steps = [
      {
        agent: {
          name: "triage",
          capability: "soc.triage.email",
          prompt: "x",
          sovereignty: { model_class: "local-only" as const, frontier_ok: false },
        },
      },
    ];
    await runSteps(steps, {}, options({ agentProvider: provider }));
    expect(provider.dispatched[0].sovereignty).toEqual({ model_class: "local-only", frontier_ok: false });
  });

  test("missing agentProvider fails fast with clear error", async () => {
    const steps = [{ agent: { name: "triage", capability: "c", prompt: "x" } }];
    await expect(runSteps(steps, {}, options())).rejects.toThrow(/no agentProvider configured/);
  });

  test("failed task result raises StepFailure", async () => {
    const provider = new MockAgentProvider({}, { failCapabilities: ["c"] });
    const steps = [{ agent: { name: "t", capability: "c", prompt: "x" } }];
    await expect(runSteps(steps, {}, options({ agentProvider: provider }))).rejects.toThrow(StepFailure);
  });

  test("timeout aborts dispatch and reports agent.timeout", async () => {
    const provider = new MockAgentProvider({ c: "never" }, { delayMs: 5_000 });
    const events: AgentEvent[] = [];
    const steps = [{ agent: { name: "slow", capability: "c", prompt: "x", timeout_ms: 30 } }];

    await expect(
      runSteps(steps, {}, options({ agentProvider: provider, onAgentEvent: (e) => events.push(e) })),
    ).rejects.toThrow(/timeout after 30ms/);
    expect(events.some((e) => e.type === "agent.timeout")).toBe(true);
  });

  test("retry primitive wraps agent steps — succeeds on second attempt", async () => {
    let calls = 0;
    const flaky: AgentProvider = {
      async dispatch(spec: AgentTaskSpec): Promise<AgentTaskResult> {
        calls++;
        if (calls === 1) {
          return { task_id: "t1", status: "failed", output: null, error: "transient", duration_ms: 1 };
        }
        return { task_id: "t2", status: "completed", output: "recovered", duration_ms: 1 };
      },
    };

    const steps = [
      {
        retry: {
          attempts: 2,
          backoff: "constant" as const,
          initial_delay_ms: 1,
          actions: [{ agent: { name: "flaky", capability: "c", prompt: "x", collect: "out" } }],
        },
      },
    ];

    const result = await runSteps(steps, {}, options({ agentProvider: flaky }));
    expect(calls).toBe(2);
    expect((result.out as AgentTaskResult).output).toBe("recovered");
  });

  test("emits dispatched and completed lifecycle events", async () => {
    const provider = new MockAgentProvider({ c: "ok" });
    const events: AgentEvent[] = [];
    const steps = [{ agent: { name: "t", capability: "c", prompt: "x" } }];

    await runSteps(steps, {}, options({ agentProvider: provider, onAgentEvent: (e) => events.push(e) }));

    expect(events.map((e) => e.type)).toEqual(["agent.dispatched", "agent.completed"]);
  });

  test("records step in stepRecords as agent:{name}", async () => {
    const provider = new MockAgentProvider({ c: "ok" });
    const records: StepRecord[] = [];
    const steps = [{ agent: { name: "t", capability: "c", prompt: "x" } }];

    await runSteps(steps, {}, options({ agentProvider: provider }), records);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("agent:t");
    expect(records[0].success).toBe(true);
  });
});

describe("agent step validation", () => {
  test("accepts a well-formed spec", () => {
    expect(() =>
      validateStep({ agent: { name: "t", capability: "c", prompt: "x" } }),
    ).not.toThrow();
  });

  test("rejects missing capability", () => {
    expect(() => validateStep({ agent: { name: "t", prompt: "x" } })).toThrow(/'capability'/);
  });

  test("rejects missing prompt", () => {
    expect(() => validateStep({ agent: { name: "t", capability: "c" } })).toThrow(/'prompt'/);
  });

  test("rejects direct mode without target_assistant", () => {
    expect(() =>
      validateStep({ agent: { name: "t", capability: "c", prompt: "x", distribution_mode: "direct" } }),
    ).toThrow(/requires 'target_assistant'/);
  });

  test("rejects non-positive timeout", () => {
    expect(() =>
      validateStep({ agent: { name: "t", capability: "c", prompt: "x", timeout_ms: 0 } }),
    ).toThrow(/'timeout_ms'/);
  });
});
