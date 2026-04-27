import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runPipeline } from "../src/lib/pipeline";
import { runSteps, validateStep, StepFailure } from "../src/lib/step-runner";
import type {
  GateProvider,
  GateInput,
  GateEvent,
  PipelineStep,
} from "../src/types/pipeline";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-gate-actions");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });

  // A_PRELUDE: sets a marker so we can verify upstream survives the gate
  const preludeDir = join(TEST_DIR, "A_PRELUDE");
  mkdirSync(preludeDir, { recursive: true });
  writeFileSync(join(preludeDir, "action.json"), JSON.stringify({
    name: "A_PRELUDE", version: "1.0.0", description: "set marker",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(preludeDir, "action.ts"), `
    export default {
      async execute(input) {
        return { ...input, prelude: "ran" };
      }
    };
  `);

  // A_AFTER_GATE: reads gate verdict + prelude marker to confirm both survive
  const afterDir = join(TEST_DIR, "A_AFTER_GATE");
  mkdirSync(afterDir, { recursive: true });
  writeFileSync(join(afterDir, "action.json"), JSON.stringify({
    name: "A_AFTER_GATE", version: "1.0.0", description: "post-gate",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(afterDir, "action.ts"), `
    export default {
      async execute(input) {
        return { ...input, post_gate: "executed", verdict_seen: input.gate?.verdict };
      }
    };
  `);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const opts = { actionDirs: [TEST_DIR] };

class StaticProvider implements GateProvider {
  constructor(private readonly input: GateInput) {}
  async requestVerdict() {
    return this.input;
  }
}

describe("gate primitive — validation", () => {
  test("accepts well-formed gate spec", () => {
    expect(() =>
      validateStep({ gate: { name: "g1", prompt: "ok?" } }),
    ).not.toThrow();
  });

  test("rejects gate without name", () => {
    expect(() =>
      validateStep({ gate: { prompt: "ok?" } }),
    ).toThrow(/'name' must be a non-empty string/);
  });

  test("rejects gate without prompt", () => {
    expect(() =>
      validateStep({ gate: { name: "g1" } }),
    ).toThrow(/'prompt' must be a non-empty string/);
  });

  test("rejects gate with non-positive timeout_ms", () => {
    expect(() =>
      validateStep({ gate: { name: "g1", prompt: "ok?", timeout_ms: 0 } }),
    ).toThrow(/timeout_ms.*must be a positive number/);
  });

  test("KNOWN_STEP_KEYS includes gate", () => {
    // sanity: dispatcher rejects unknown keys, accepts gate
    expect(() => validateStep({ unknown_key: {} })).toThrow();
    expect(() => validateStep({ gate: { name: "g", prompt: "p" } })).not.toThrow();
  });
});

describe("gate primitive — runtime", () => {
  test("blocks until provider returns, then merges result into context", async () => {
    const events: GateEvent[] = [];
    const result = await runSteps(
      [
        "A_PRELUDE",
        { gate: { name: "release-gate", prompt: "ship it?" } },
        "A_AFTER_GATE",
      ] as PipelineStep[],
      {},
      {
        ...opts,
        gateProvider: new StaticProvider({ verdict: "pass", notes: "looks good" }),
        onGateEvent: (e) => events.push(e),
      },
    );

    expect(result.prelude).toBe("ran");
    expect(result.post_gate).toBe("executed");
    expect(result.verdict_seen).toBe("pass");
    expect((result.gate as { verdict: string }).verdict).toBe("pass");
    expect((result.gate as { notes: string }).notes).toBe("looks good");
    expect((result.gate as { name: string }).name).toBe("release-gate");
    expect(typeof (result.gate as { opened_at: string }).opened_at).toBe("string");
    expect(typeof (result.gate as { closed_at: string }).closed_at).toBe("string");

    // Events: opened then closed
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("gate.opened");
    expect(events[1].type).toBe("gate.closed");
    if (events[1].type === "gate.closed") {
      expect(events[1].verdict).toBe("pass");
    }
  });

  test("verdict=fail throws StepFailure with notes", async () => {
    let caught: unknown;
    try {
      await runSteps(
        [{ gate: { name: "veto", prompt: "ok?" } }] as PipelineStep[],
        {},
        {
          ...opts,
          gateProvider: new StaticProvider({ verdict: "fail", notes: "broken UI" }),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StepFailure);
    expect((caught as Error).message).toContain("verdict=fail");
    expect((caught as Error).message).toContain("broken UI");
  });

  test("timeout aborts provider and throws StepFailure", async () => {
    // Provider that never returns unless aborted.
    class HangingProvider implements GateProvider {
      requestVerdict(spec: { signal?: AbortSignal }): Promise<GateInput> {
        return new Promise((_resolve, reject) => {
          spec.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }

    const events: GateEvent[] = [];
    let caught: unknown;
    try {
      await runSteps(
        [{ gate: { name: "slow", prompt: "ok?", timeout_ms: 50 } }] as PipelineStep[],
        {},
        {
          ...opts,
          gateProvider: new HangingProvider(),
          onGateEvent: (e) => events.push(e),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StepFailure);
    expect((caught as Error).message).toMatch(/gate timeout after 50ms/);
    expect(events.some((e) => e.type === "gate.timeout")).toBe(true);
  });

  test("custom collect field writes verdict elsewhere", async () => {
    const result = await runSteps(
      [{ gate: { name: "g", prompt: "?", collect: "ship_decision" } }] as PipelineStep[],
      { keep: "alive" },
      {
        ...opts,
        gateProvider: new StaticProvider({ verdict: "pass", notes: "ok" }),
      },
    );
    expect(result.keep).toBe("alive");
    expect((result.ship_decision as { verdict: string }).verdict).toBe("pass");
    expect(result.gate).toBeUndefined();
  });
});

describe("gate primitive — integration via runPipeline", () => {
  test("full pipeline pauses at gate, resumes after operator input", async () => {
    const events: GateEvent[] = [];
    const result = await runPipeline(
      {
        name: "P_GATE_DEMO",
        actions: [
          "A_PRELUDE",
          { gate: { name: "deploy-check", prompt: "Deploy to prod?" } },
          "A_AFTER_GATE",
        ] as PipelineStep[],
      },
      { trigger: "ci" },
      {
        ...opts,
        gateProvider: new StaticProvider({ verdict: "pass", notes: "metrics green" }),
        onGateEvent: (e: GateEvent) => events.push(e),
      },
    );

    expect(result.success).toBe(true);
    expect(result.output?.trigger).toBe("ci");
    expect(result.output?.prelude).toBe("ran");
    expect(result.output?.post_gate).toBe("executed");
    expect((result.output?.gate as { verdict: string }).verdict).toBe("pass");
    expect((result.output?.gate as { notes: string }).notes).toBe("metrics green");

    // Events captured the lifecycle
    expect(events[0].type).toBe("gate.opened");
    expect(events[1].type).toBe("gate.closed");
  });
});
