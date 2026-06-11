/**
 * P-805 — execution wiring: compose → validate → ack → run with per-step
 * thread replies. ISC-35..37 (stub-safe paths; live MM = DEFERRED-VERIFY,
 * blocked on the composer bot identity, design §10 Q1).
 */

import { describe, expect, test } from "bun:test";
import type { ActionStepEvent, GateProvider } from "../src/types/pipeline";
import { runScenario, stepLine, makeStubLLM, BLOCKS_DIR } from "../examples/soc-demo/run-demo";
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
