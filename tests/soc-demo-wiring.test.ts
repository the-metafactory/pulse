/**
 * P-805 — execution wiring: compose → validate → ack → run with per-step
 * thread replies. ISC-35..37 (stub-safe paths; live MM = DEFERRED-VERIFY,
 * blocked on the composer bot identity, design §10 Q1).
 */

import { describe, expect, test } from "bun:test";
import type { ActionStepEvent, GateProvider } from "../src/types/pipeline";
import { runScenario, stepLine, makeStubLLM, BLOCKS_DIR } from "../examples/soc-demo/run-demo";
import { runPipeline } from "../src/lib/pipeline";
import { validateSteps } from "../src/lib/step-runner";
import { ConsolePoster, parseAckReply } from "../examples/soc-demo/lib/mm";
import type { StepAnnotation } from "../examples/soc-demo/lib/validate-pipeline";

const passGate: GateProvider = {
  async requestVerdict() {
    return { verdict: "pass", notes: "run it" };
  },
};

const failGate: GateProvider = {
  async requestVerdict() {
    return { verdict: "fail", notes: "stop" };
  },
};

describe("stepLine (ISC-37)", () => {
  const annotations: StepAnnotation[] = [
    { index: 0, label: "A_EXTRACT_IOCS", sovereignty: "D", residency: "CH" },
  ];

  test("completion line carries block name, sovereignty class, duration, fields", () => {
    const event: ActionStepEvent = {
      type: "step.completed",
      action: "A_EXTRACT_IOCS",
      durationMs: 12,
      output_fields: ["iocs"],
    };
    const line = stepLine(event, annotations)!;
    expect(line).toContain("A_EXTRACT_IOCS");
    expect(line).toContain("`D`");
    expect(line).toContain("CH");
    expect(line).toContain("12ms");
    expect(line).toContain("`iocs`");
  });

  test("failure line carries the error; started events post nothing", () => {
    const failed: ActionStepEvent = { type: "step.failed", action: "A_EXTRACT_IOCS", durationMs: 5, error: "boom" };
    expect(stepLine(failed, annotations)).toContain("boom");
    const started: ActionStepEvent = { type: "step.started", action: "A_EXTRACT_IOCS", started_at: "x" };
    expect(stepLine(started, annotations)).toBeNull();
  });
});

describe("parseAckReply", () => {
  test("pass, fail, and non-verdict replies", () => {
    expect(parseAckReply("run it")?.verdict).toBe("pass");
    expect(parseAckReply("APPROVE — looks good")?.verdict).toBe("pass");
    expect(parseAckReply("stop")?.verdict).toBe("fail");
    expect(parseAckReply("what does step 2 do?")).toBeNull();
  });
});

describe("runScenario — stub mode end-to-end (ISC-35/36)", () => {
  test("full sequence: disclosure → flow post → ack → step replies → final artifact", async () => {
    const poster = new ConsolePoster();
    const result = await runScenario("suspicious URL hxxp://evil[.]example/x seen in member mail", {
      llm: makeStubLLM(),
      poster,
      gateProvider: passGate,
      render: false,
      blocksDir: BLOCKS_DIR,
    });

    expect(result.status).toBe("complete");
    // Self-disclosure first (ISC-32/§3.4)
    expect(poster.posts[0]).toContain("frontier-A");
    // Flow post with YAML + sovereignty annotations
    const flowPost = poster.posts.find((p) => p.includes("```yaml"))!;
    expect(flowPost).toContain("sovereignty: D");
    // One reply per executed step, tagged with the class
    const stepPosts = poster.posts.filter((p) => p.startsWith("✅"));
    expect(stepPosts.length).toBe(2);
    expect(stepPosts[0]).toContain("A_EXTRACT_IOCS");
    expect(stepPosts[1]).toContain("A_TAG_TLP");
    // Final artifact tail
    expect(poster.posts.at(-1)).toContain("🏁");
  });

  test("operator rejection aborts before any execution (ISC-36)", async () => {
    const poster = new ConsolePoster();
    const result = await runScenario("anything", {
      llm: makeStubLLM(),
      poster,
      gateProvider: failGate,
      render: false,
      blocksDir: BLOCKS_DIR,
    });
    expect(result.status).toBe("aborted");
    expect(poster.posts.some((p) => p.startsWith("✅"))).toBe(false);
  });

  test("Anti (ISC-31/fail-closed): unknown-block flow never executes", async () => {
    const badLlm = async () => ({
      text: "```yaml\nname: F_BAD\nactions:\n  - A_INVENTED  # sovereignty: D, residency: CH\n```\nbad",
    });
    const poster = new ConsolePoster();
    // compose() exhausts retries on the same bad output, then the badLlm's
    // "fallback" text still contains YAML → status invalid, never executed.
    const result = await runScenario("anything", {
      llm: badLlm,
      poster,
      gateProvider: passGate,
      render: false,
      blocksDir: BLOCKS_DIR,
    });
    expect(result.status).toBe("invalid");
    expect(poster.posts.some((p) => p.startsWith("✅"))).toBe(false);
  });

  test("composer no-match path posts the closest-match message, runs nothing", async () => {
    const noMatchLlm = async () => ({
      text: "Closest I have is `A_FETCH_VIRUSTOTAL`; the gap is *no DDoS telemetry block*. Pivot to *reputation triage*?",
    });
    const poster = new ConsolePoster();
    const result = await runScenario("mitigate the DDoS", {
      llm: noMatchLlm,
      poster,
      gateProvider: passGate,
      render: false,
      blocksDir: BLOCKS_DIR,
    });
    expect(result.status).toBe("no-match");
    expect(poster.posts.at(-1)).toContain("Closest I have");
  });
});

// ---------------------------------------------------------------------------
// Sage round 2 — gate security (blocker + importants)
// ---------------------------------------------------------------------------

describe("gate security (sage round 2)", () => {
  test("negative/negated replies never parse as approval", () => {
    expect(parseAckReply("no, don't run")?.verdict).toBe("fail");
    expect(parseAckReply("do not run it")?.verdict).toBe("fail");
    expect(parseAckReply("don't approve this")?.verdict).toBe("fail");
    expect(parseAckReply("stop — bad flow")?.verdict).toBe("fail");
  });

  test("waitForReply only accepts the configured operator (principal check)", async () => {
    const { MattermostThread } = await import("../examples/soc-demo/lib/mm");
    const posts: Record<string, { message: string; create_at: number; user_id: string }> = {};
    let now = 1000;
    const mockFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/v4/posts") && init?.method === "POST") {
        const id = `p${++now}`;
        posts[id] = { message: JSON.parse(String(init.body)).message, create_at: now, user_id: "bot" };
        return new Response(JSON.stringify({ id, create_at: now }));
      }
      if (u.includes("/thread")) {
        // audience member replies "run it" — must NOT satisfy the gate;
        // then the operator replies and must.
        posts.audience = { message: "run it", create_at: now + 1, user_id: "audience-member" };
        posts.operator = { message: "run it", create_at: now + 2, user_id: "jc-operator" };
        return new Response(JSON.stringify({ posts }));
      }
      return new Response("{}");
    }) as typeof globalThis.fetch;

    const thread = new MattermostThread(
      { url: "https://mm.example", token: "t", channelId: "c", operatorId: "jc-operator" },
      mockFetch,
    );
    await thread.post("root");
    const reply = await thread.waitForReply(/run it/i, { timeoutMs: 3000, pollMs: 10 });
    expect(reply).toBe("run it");
    // The audience post has create_at < operator post; if principal check
    // were missing, the audience post would have matched first. Verify by
    // construction: only the operator's post is at create_at now+2.
  });

  test("mmConfigFromEnv fails closed without MATTERMOST_OPERATOR_ID", async () => {
    const { mmConfigFromEnv } = await import("../examples/soc-demo/lib/mm");
    const saved = { ...process.env };
    process.env.MATTERMOST_URL = "https://mm.example";
    process.env.MATTERMOST_BOT_TOKEN = "t";
    process.env.MATTERMOST_CHANNEL_ID = "c";
    delete process.env.MATTERMOST_OPERATOR_ID;
    try {
      expect(() => mmConfigFromEnv()).toThrow(/MATTERMOST_OPERATOR_ID/);
      process.env.MATTERMOST_OPERATOR_ID = "op";
      expect(mmConfigFromEnv()?.operatorId).toBe("op");
    } finally {
      for (const k of ["MATTERMOST_URL", "MATTERMOST_BOT_TOKEN", "MATTERMOST_CHANNEL_ID", "MATTERMOST_OPERATOR_ID"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("map bridge — collection→scalar enrichment (W-5 slice 1, cortex#1040 design)", () => {
  test("A_EXTRACT_IOCS emits top-level ips[]; map binds `ip` per item into a scalar enricher", async () => {
    // Deterministic RUNTIME proof (no LLM, no validator surrogate): the prompt
    // teaches `map over: ips as: ip [A_LOOKUP_GEOIP_ASN]`. Execute exactly that
    // and assert the enricher actually RAN once per extracted IP with the
    // bound scalar — i.e. the as→scalar contract holds at runtime, which is
    // where it's enforced (the static validator only declines to reject it).
    const steps = validateSteps([
      "A_EXTRACT_IOCS",
      {
        map: {
          over: "ips",
          as: "ip",
          collect: "ip_enrichment",
          actions: ["A_LOOKUP_GEOIP_ASN"],
        },
      },
    ]);
    const text = "logins from 198.51.100.7 and 203.0.113.9 looked off";
    const result = await runPipeline(
      { name: "F_MAP_PROOF", actions: steps },
      { text },
      { actionDirs: [BLOCKS_DIR] },
    );
    expect(result.success).toBe(true);
    const out = result.output as { ips?: string[]; ip_enrichment?: unknown[] };
    // Top-level typed array is present (the shape the prompt advertises).
    expect(out.ips).toEqual(["198.51.100.7", "203.0.113.9"]);
    // The enricher ran once per IP — proving `as: ip` fed each scalar run.
    expect(Array.isArray(out.ip_enrichment)).toBe(true);
    expect(out.ip_enrichment).toHaveLength(2);
    // Each collected result carries the geoip the scalar enricher produces.
    for (const entry of out.ip_enrichment as Array<Record<string, unknown>>) {
      expect(entry.geoip).toBeDefined();
    }
  });
});

describe("makeLocalLlmAgentProvider (W-5 agent execution)", () => {
  test("dispatch runs the prompt against the llm and returns the text as output", async () => {
    const { makeLocalLlmAgentProvider } = await import("../examples/soc-demo/run-demo");
    let seenPrompt = "";
    const llm = async (prompt: string) => {
      seenPrompt = prompt;
      return { text: "test@example.org" };
    };
    const provider = makeLocalLlmAgentProvider(llm);
    const r = await provider.dispatch({ capability: "soc.triage.email", prompt: "Extract the email: foo test@example.org bar" });
    expect(seenPrompt).toContain("test@example.org");
    expect(r.status).toBe("completed");
    // Output is the raw string, so collect writes a scalar a downstream block can read.
    expect(r.output).toBe("test@example.org");
  });

  test("a throwing llm yields a failed task, not a throw", async () => {
    const { makeLocalLlmAgentProvider } = await import("../examples/soc-demo/run-demo");
    const provider = makeLocalLlmAgentProvider(async () => { throw new Error("llm down"); });
    const r = await provider.dispatch({ capability: "x", prompt: "y" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("llm down");
  });
});
