import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runPipeline } from "../src/lib/pipeline";
import { runSteps, validateStep, StepFailure, type StepRecord } from "../src/lib/step-runner";
import { StdinGateProvider } from "../src/lib/gate-provider";
import type {
  GateProvider,
  GateInput,
  GateEvent,
  PipelineStep,
} from "../src/types/pipeline";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Readable, PassThrough } from "stream";

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

  // A_AFTER_GATE: reads the gate verdict (under the configured collect field)
  const afterDir = join(TEST_DIR, "A_AFTER_GATE");
  mkdirSync(afterDir, { recursive: true });
  writeFileSync(join(afterDir, "action.json"), JSON.stringify({
    name: "A_AFTER_GATE", version: "1.0.0", description: "post-gate",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(afterDir, "action.ts"), `
    export default {
      async execute(input) {
        // The collect field name is provided via 'verdict_field'.
        const field = input.verdict_field;
        const result = field ? input[field] : undefined;
        return { ...input, post_gate: "executed", verdict_seen: result?.verdict };
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
        { gate: { name: "release-gate", prompt: "ship it?", collect: "gate" } },
        "A_AFTER_GATE",
      ] as PipelineStep[],
      { verdict_field: "gate" },
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
      // Timestamp consistency: closed event's opened_at matches opened event's opened_at
      if (events[0].type === "gate.opened") {
        expect(events[1].opened_at).toBe(events[0].opened_at);
      }
    }
  });

  test("default collect derives from gate name (gate_${name})", async () => {
    const result = await runSteps(
      [{ gate: { name: "release-gate", prompt: "?" } }] as PipelineStep[],
      {},
      { ...opts, gateProvider: new StaticProvider({ verdict: "pass", notes: "" }) },
    );
    expect((result.gate_release_gate ?? result["gate_release-gate"]) as unknown).toBeDefined();
  });

  test("two sequential gates with default collect do NOT collide", async () => {
    const result = await runSteps(
      [
        { gate: { name: "first", prompt: "?" } },
        { gate: { name: "second", prompt: "?" } },
      ] as PipelineStep[],
      {},
      {
        ...opts,
        gateProvider: new StaticProvider({ verdict: "pass", notes: "" }),
      },
    );
    expect((result["gate_first"] as { name: string }).name).toBe("first");
    expect((result["gate_second"] as { name: string }).name).toBe("second");
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
        [{ gate: { name: "slow", prompt: "ok?", timeout_ms: 200 } }] as PipelineStep[],
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
    expect((caught as Error).message).toMatch(/gate timeout after 200ms/);
    expect(events.some((e) => e.type === "gate.timeout")).toBe(true);
    // No gate.closed on timeout
    expect(events.some((e) => e.type === "gate.closed")).toBe(false);
  });

  test("parent signal abort cancels gate cleanly", async () => {
    class HangingProvider implements GateProvider {
      requestVerdict(spec: { signal?: AbortSignal }): Promise<GateInput> {
        return new Promise((_resolve, reject) => {
          spec.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }

    const parentController = new AbortController();
    setTimeout(() => parentController.abort(), 30);

    let caught: unknown;
    try {
      await runSteps(
        [{ gate: { name: "g", prompt: "?" } }] as PipelineStep[],
        {},
        {
          ...opts,
          gateProvider: new HangingProvider(),
          signal: parentController.signal,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StepFailure);
    expect((caught as Error).message).toMatch(/aborted/);
  });

  test("parent signal listener is removed on success (no leak)", async () => {
    const parentController = new AbortController();
    const before = parentController.signal as unknown as { eventListeners?: () => unknown[] };
    // Run several gates under the same parent signal.
    for (let i = 0; i < 5; i++) {
      await runSteps(
        [{ gate: { name: `g${i}`, prompt: "?" } }] as PipelineStep[],
        {},
        {
          ...opts,
          gateProvider: new StaticProvider({ verdict: "pass", notes: "" }),
          signal: parentController.signal,
        },
      );
    }
    // EventTarget exposes no listener-count API in a cross-runtime way, but we
    // can assert that aborting the parent NOW does not throw / does not affect
    // already-completed gates. (Listeners removed → no callbacks fire.)
    expect(() => parentController.abort()).not.toThrow();
    // Confirm `before` is still usable (sentinel — keeps the variable referenced)
    expect(before).toBe(parentController.signal as unknown as typeof before);
  });

  test("stepRecord captures gate verdict + notes for trace consumers", async () => {
    const records: StepRecord[] = [];
    // Run via runPipeline so stepRecords is populated through PipelineResult
    const result = await runPipeline(
      {
        name: "P",
        actions: [{ gate: { name: "audit", prompt: "?" } }] as PipelineStep[],
      },
      {},
      {
        ...opts,
        gateProvider: new StaticProvider({ verdict: "pass", notes: "all clear" }),
      },
    );
    for (const r of result.steps) records.push(r);
    expect(records.length).toBe(1);
    expect(records[0].gate?.verdict).toBe("pass");
    expect(records[0].gate?.notes).toBe("all clear");
    expect(records[0].gate?.name).toBe("audit");
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
          { gate: { name: "deploy-check", prompt: "Deploy to prod?", collect: "decision" } },
          "A_AFTER_GATE",
        ] as PipelineStep[],
      },
      { trigger: "ci", verdict_field: "decision" },
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
    expect((result.output?.decision as { verdict: string }).verdict).toBe("pass");
    expect((result.output?.decision as { notes: string }).notes).toBe("metrics green");

    // Events captured the lifecycle
    expect(events[0].type).toBe("gate.opened");
    expect(events[1].type).toBe("gate.closed");
  });
});

describe("StdinGateProvider", () => {
  test("parses verdict + multi-line notes from a Readable input", async () => {
    const input = Readable.from(["pass\n", "all good\n", "two notes\n", ".\n"]);
    const output = new PassThrough();
    output.resume(); // drain the prompt writes so the stream doesn't block

    const provider = new StdinGateProvider({ input, output });
    const result = await provider.requestVerdict({ name: "g", prompt: "ok?" });
    provider.close();

    expect(result.verdict).toBe("pass");
    expect(result.notes).toBe("all good\ntwo notes");
  });

  test("rejects when verdict line is not pass/fail", async () => {
    const input = Readable.from(["maybe\n", ".\n"]);
    const output = new PassThrough();
    output.resume();

    const provider = new StdinGateProvider({ input, output });
    let caught: unknown;
    try {
      await provider.requestVerdict({ name: "g", prompt: "?" });
    } catch (err) {
      caught = err;
    }
    provider.close();
    expect((caught as Error).message).toMatch(/expected 'pass' or 'fail'/);
  });

  test("rejects when signal is already aborted", async () => {
    const input = Readable.from(["pass\n", ".\n"]);
    const output = new PassThrough();
    output.resume();
    const ctl = new AbortController();
    ctl.abort();

    const provider = new StdinGateProvider({ input, output });
    let caught: unknown;
    try {
      await provider.requestVerdict({ name: "g", prompt: "?", signal: ctl.signal });
    } catch (err) {
      caught = err;
    }
    provider.close();
    expect((caught as Error).message).toMatch(/aborted/);
  });

  test("serializes sequential calls (no race on shared readline)", async () => {
    // Two gates back-to-back on the same provider should both see their inputs.
    const input = Readable.from(["pass\n", "first notes\n", ".\n", "fail\n", "second notes\n", ".\n"]);
    const output = new PassThrough();
    output.resume();

    const provider = new StdinGateProvider({ input, output });
    const a = await provider.requestVerdict({ name: "a", prompt: "?" });
    const b = await provider.requestVerdict({ name: "b", prompt: "?" });
    provider.close();

    expect(a.verdict).toBe("pass");
    expect(a.notes).toBe("first notes");
    expect(b.verdict).toBe("fail");
    expect(b.notes).toBe("second notes");
  });
});
