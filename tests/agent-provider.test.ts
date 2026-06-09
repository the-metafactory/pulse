/**
 * Agent provider tests — envelope shape, subject grammar, dispatch lifecycle,
 * abort cleanup, and the mock provider contract.
 */

import { describe, test, expect } from "bun:test";
import {
  MyelinAgentProvider,
  MockAgentProvider,
  InMemoryAgentTransport,
  encodeDidSegment,
  subjectMatches,
} from "../src/lib/agent-provider";
import type { AgentTaskSpec } from "../src/types/agent";

const baseSpec: AgentTaskSpec = {
  capability: "soc.triage.email",
  prompt: "Analyze this email",
};

function makeProvider(transport: InMemoryAgentTransport) {
  return new MyelinAgentProvider({
    transport,
    principal: "switch-soc",
    stack: "default",
  });
}

/** Simulated fleet agent: answers every task on the dispatch lifecycle. */
async function respondToTasks(
  transport: InMemoryAgentTransport,
  respond: (envelope: Record<string, any>) => { state: "completed" | "failed"; payload: Record<string, unknown> },
) {
  await transport.subscribe("local.switch-soc.default.tasks.>", (_subject, data) => {
    const envelope = JSON.parse(data);
    const { state, payload } = respond(envelope);
    void transport.publish(
      `local.switch-soc.default.dispatch.task.${state}`,
      JSON.stringify({
        id: crypto.randomUUID(),
        source: "switch-soc.default.fleet-sim",
        type: `dispatch.task.${state}`,
        timestamp: new Date().toISOString(),
        correlation_id: envelope.correlation_id,
        sovereignty: envelope.sovereignty,
        payload,
      }),
    );
  });
}

describe("subjectMatches", () => {
  test("exact match", () => {
    expect(subjectMatches("a.b.c", "a.b.c")).toBe(true);
    expect(subjectMatches("a.b.c", "a.b.d")).toBe(false);
    expect(subjectMatches("a.b", "a.b.c")).toBe(false);
  });

  test("* matches one token", () => {
    expect(subjectMatches("a.*.c", "a.b.c")).toBe(true);
    expect(subjectMatches("a.*.c", "a.b.d")).toBe(false);
    expect(subjectMatches("a.*", "a.b.c")).toBe(false);
  });

  test("> matches the rest", () => {
    expect(subjectMatches("a.>", "a.b.c.d")).toBe(true);
    expect(subjectMatches("a.b.>", "a.b")).toBe(false);
  });
});

describe("encodeDidSegment", () => {
  test("encodes colon and dot per myelin#135", () => {
    expect(encodeDidSegment("did:mf:hub.metafactory")).toBe("@did-mf-hub--metafactory");
  });
});

describe("MyelinAgentProvider envelope", () => {
  test("builds v3 envelope with sovereignty round-trip", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    const envelope = provider.buildEnvelope(
      {
        ...baseSpec,
        sovereignty: { model_class: "local-only", frontier_ok: false, data_residency: "CH" },
        timeout_ms: 5000,
      },
      "task-123",
    );

    expect(envelope.type).toBe("tasks.soc.triage.email");
    expect(envelope.source).toBe("switch-soc.default.pulse");
    expect(envelope.correlation_id).toBe("task-123");
    expect(envelope.sovereignty.model_class).toBe("local-only");
    expect(envelope.sovereignty.frontier_ok).toBe(false);
    expect(envelope.sovereignty.data_residency).toBe("CH");
    expect(envelope.sovereignty.classification).toBe("local");
    expect(envelope.requirements).toEqual(["soc.triage.email"]);
    expect(envelope.distribution_mode).toBe("offer");
    expect(envelope.payload.prompt).toBe("Analyze this email");
    expect(envelope.deadline).toBeDefined();
  });

  test("offer subject follows myelin task grammar", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    expect(provider.taskSubject(baseSpec)).toBe("local.switch-soc.default.tasks.soc.triage.email");
  });

  test("direct subject encodes target DID", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    const subject = provider.taskSubject({
      ...baseSpec,
      distribution_mode: "direct",
      target_assistant: "did:mf:sage.switch",
    });
    expect(subject).toBe("local.switch-soc.default.tasks.@did-mf-sage--switch.soc.triage.email");
  });

  test("direct without target_assistant throws", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    expect(() => provider.taskSubject({ ...baseSpec, distribution_mode: "direct" })).toThrow(
      /requires target_assistant/,
    );
  });

  test("rejects capability with wildcard or whitespace (malformed subject)", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    expect(() => provider.taskSubject({ ...baseSpec, capability: "soc.*.email" })).toThrow(/not a valid subject/);
    expect(() => provider.taskSubject({ ...baseSpec, capability: "soc triage" })).toThrow(/not a valid subject/);
    expect(() => provider.taskSubject({ ...baseSpec, capability: "soc..email" })).toThrow(/not a valid subject/);
    // dotted capabilities are legal — dots are the subject token separator
    expect(provider.taskSubject({ ...baseSpec, capability: "soc.triage.email" })).toContain("tasks.soc.triage.email");
  });

  test("default sovereignty base carries no deployment-specific residency", () => {
    const provider = makeProvider(new InMemoryAgentTransport());
    const envelope = provider.buildEnvelope({ capability: "c", prompt: "p" }, "t1");
    expect(envelope.sovereignty.data_residency).toBe("ZZ"); // generic, not "CH"
    expect(envelope.sovereignty.model_class).toBe("local-only"); // safe-by-default
  });
});

describe("MyelinAgentProvider dispatch", () => {
  test("resolves on dispatch.task.completed with matching correlation_id", async () => {
    const transport = new InMemoryAgentTransport();
    await respondToTasks(transport, (envelope) => ({
      state: "completed",
      payload: { task_id: envelope.payload.task_id, output: { verdict: "phishing" }, agent_id: "local-llm", model: "llama3.2" },
    }));

    const provider = makeProvider(transport);
    const result = await provider.dispatch(baseSpec);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ verdict: "phishing" });
    expect(result.agent).toBe("local-llm");
    expect(result.model).toBe("llama3.2");
  });

  test("resolves with failed status on dispatch.task.failed", async () => {
    const transport = new InMemoryAgentTransport();
    await respondToTasks(transport, () => ({
      state: "failed",
      payload: { error: "no agent claimed the task" },
    }));

    const provider = makeProvider(transport);
    const result = await provider.dispatch(baseSpec);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("no agent claimed the task");
  });

  test("ignores lifecycle traffic for other tasks", async () => {
    const transport = new InMemoryAgentTransport();
    await transport.subscribe("local.switch-soc.default.tasks.>", (_subject, data) => {
      const envelope = JSON.parse(data);
      // First emit a foreign completion, then the real one.
      void transport
        .publish(
          "local.switch-soc.default.dispatch.task.completed",
          JSON.stringify({ correlation_id: "someone-else", payload: { output: "WRONG" } }),
        )
        .then(() =>
          transport.publish(
            "local.switch-soc.default.dispatch.task.completed",
            JSON.stringify({ correlation_id: envelope.correlation_id, payload: { output: "RIGHT" } }),
          ),
        );
    });

    const provider = makeProvider(transport);
    const result = await provider.dispatch(baseSpec);
    expect(result.output).toBe("RIGHT");
  });

  test("rejects on abort and cleans up the subscription", async () => {
    const transport = new InMemoryAgentTransport();
    const provider = makeProvider(transport);
    const controller = new AbortController();

    const pending = provider.dispatch(baseSpec, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    // Only the (nonexistent) fleet subscription remains — provider must have unsubscribed.
    expect(transport.subscriptionCount).toBe(0);
  });

  test("cleans up subscription after successful dispatch", async () => {
    const transport = new InMemoryAgentTransport();
    await respondToTasks(transport, () => ({ state: "completed", payload: { output: "ok" } }));

    const provider = makeProvider(transport);
    await provider.dispatch(baseSpec);
    // The fleet responder subscription stays; the provider's lifecycle sub must be gone.
    expect(transport.subscriptionCount).toBe(1);
  });
});

describe("MockAgentProvider", () => {
  test("returns scripted result by capability", async () => {
    const provider = new MockAgentProvider({ "soc.triage.email": { verdict: "phishing" } });
    const result = await provider.dispatch(baseSpec);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ verdict: "phishing" });
    expect(provider.dispatched).toHaveLength(1);
  });

  test("function scripts receive the spec", async () => {
    const provider = new MockAgentProvider({
      "soc.triage.email": (spec: AgentTaskSpec) => ({ echoed: spec.prompt }),
    });
    const result = await provider.dispatch(baseSpec);
    expect(result.output).toEqual({ echoed: "Analyze this email" });
  });

  test("unknown capability fails", async () => {
    const provider = new MockAgentProvider({});
    const result = await provider.dispatch(baseSpec);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no mock script/);
  });

  test("failCapabilities simulates fleet failure", async () => {
    const provider = new MockAgentProvider(
      { "soc.triage.email": "unused" },
      { failCapabilities: ["soc.triage.email"] },
    );
    const result = await provider.dispatch(baseSpec);
    expect(result.status).toBe("failed");
  });
});
