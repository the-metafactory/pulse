/**
 * Tribunal step primitive tests — the runner: concurrent seat dispatch,
 * the three governance-plan acceptance scenarios (split → tiebreaker,
 * monoculture → auto-reassign, abstain → deny), defer semantics, events,
 * timeout/abort handling, retry composition, and validation.
 */

import { describe, test, expect } from "bun:test";
import { runSteps, validateStep, StepFailure } from "../src/lib/step-runner";
import type { StepRunnerOptions } from "../src/lib/step-runner";
import type { AgentDispatchOptions, AgentProvider, AgentTaskResult, AgentTaskSpec } from "../src/types/agent";
import type { TribunalEvent, TribunalStepSpec, TribunalVerdict } from "../src/types/tribunal";

function options(overrides: Partial<StepRunnerOptions> = {}): StepRunnerOptions {
  return { actionDirs: [], ...overrides };
}

interface SeatScript {
  /** Raw output the seat returns (vote object, JSON string, prose...). */
  output?: unknown;
  /** Executing model reported back. Distinct per seat unless testing post-hoc. */
  model?: string;
  /** Resolve as a failed task. */
  fail?: string;
  /** Never resolve until aborted. */
  hang?: boolean;
  delayMs?: number;
}

/**
 * Scripted panel provider keyed by capability. Unlike MockAgentProvider it
 * reports a distinct model per seat (the mock's fixed "mock" model would trip
 * the post-hoc monoculture downgrade on every multi-seat allow).
 */
class PanelProvider implements AgentProvider {
  public dispatched: AgentTaskSpec[] = [];
  public inFlight = 0;
  public maxInFlight = 0;

  constructor(private script: Record<string, SeatScript>) {}

  async dispatch(spec: AgentTaskSpec, opts: AgentDispatchOptions = {}): Promise<AgentTaskResult> {
    this.dispatched.push(spec);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const entry = this.script[spec.capability] ?? {};
    try {
      if (entry.hang) {
        await new Promise<never>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("seat dispatch aborted")), {
            once: true,
          });
        });
      }
      if (entry.delayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, entry.delayMs));
      }
      if (entry.fail) {
        return { task_id: "t", status: "failed", output: null, error: entry.fail, duration_ms: 1 };
      }
      return {
        task_id: "t",
        status: "completed",
        output: entry.output,
        duration_ms: 1,
        model: entry.model ?? `model-${spec.capability}`,
      };
    } finally {
      this.inFlight--;
    }
  }
}

const allowOut = (confidence = 0.9) => ({ verdict: "allow", confidence, reason: "clean" });
const denyOut = (confidence = 0.9) => ({ verdict: "deny", confidence, reason: "risky" });

function tribunalStep(spec: Omit<TribunalStepSpec, "name"> & { name?: string }) {
  return [{ tribunal: { name: "t", ...spec } }];
}

const twoSeats = [
  { name: "security", capability: "lens.security", prompt: "Assess {action}", sovereignty: { model_class: "frontier" as const } },
  { name: "code", capability: "lens.code", prompt: "Assess {action}", sovereignty: { model_class: "local-only" as const } },
];
const threeSeats = [
  ...twoSeats,
  { name: "injection", capability: "lens.injection", prompt: "Assess {action}", sovereignty: { model_class: "any" as const } },
];

describe("tribunal — acceptance scenarios (governance plan Stage 3)", () => {
  test("a split panel convenes a tiebreaker", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: denyOut() },
      "lens.tiebreak": { output: allowOut(0.8) },
    });
    const events: TribunalEvent[] = [];
    const result = await runSteps(
      tribunalStep({
        seats: twoSeats,
        tiebreaker: { name: "oracle", capability: "lens.tiebreak", prompt: "Break the tie on {action}" },
      }),
      { action: "block domain evil.test" },
      options({ agentProvider: provider, onTribunalEvent: (e) => events.push(e) }),
    );

    const verdict = result.tribunal_t as TribunalVerdict;
    expect(verdict.verdict).toBe("allow"); // 2 allow / 1 deny, robust
    expect(verdict.tiebreak?.seat).toBe("oracle");
    expect(events.some((e) => e.type === "tribunal.tiebreak")).toBe(true);
    expect(provider.dispatched).toHaveLength(3);
  });

  test("a same-model panel auto-reassigns one seat", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: allowOut() },
    });
    const monoculture = [
      { name: "security", capability: "lens.security", prompt: "x", sovereignty: { model_class: "frontier" as const } },
      { name: "code", capability: "lens.code", prompt: "x", sovereignty: { model_class: "frontier" as const } },
    ];
    const result = await runSteps(
      tribunalStep({ seats: monoculture }),
      {},
      options({ agentProvider: provider }),
    );

    const verdict = result.tribunal_t as TribunalVerdict;
    expect(verdict.diversity.reassigned_seat).toBe("code");
    // The reassigned seat was DISPATCHED with the restricted class.
    const codeDispatch = provider.dispatched.find((d) => d.capability === "lens.code");
    expect(codeDispatch?.sovereignty?.model_class).toBe("local-only");
    expect(codeDispatch?.sovereignty?.frontier_ok).toBe(false);
  });

  test("an abstaining panel denies", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: "I cannot decide, it depends" },
      "lens.code": { output: "needs more context" },
    });
    await expect(
      runSteps(tribunalStep({ seats: twoSeats }), {}, options({ agentProvider: provider })),
    ).rejects.toThrow(/verdict=deny.*abstaining panel denies/);
  });
});

describe("tribunal — rulings and defer semantics", () => {
  test("unanimous allow merges full verdict under default collect field", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: allowOut() },
      "lens.injection": { output: allowOut() },
    });
    const result = await runSteps(
      tribunalStep({ seats: threeSeats }),
      { action: "x", keep: 1 },
      options({ agentProvider: provider }),
    );
    const verdict = result.tribunal_t as TribunalVerdict;
    expect(verdict.verdict).toBe("allow");
    expect(verdict.votes).toHaveLength(3);
    expect(verdict.diversity.classes).toContain("frontier");
    expect(result.keep).toBe(1); // passthrough preserved
  });

  test("majority deny raises StepFailure", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: denyOut() },
      "lens.code": { output: denyOut() },
      "lens.injection": { output: allowOut() },
    });
    await expect(
      runSteps(tribunalStep({ seats: threeSeats }), { action: "x" }, options({ agentProvider: provider })),
    ).rejects.toThrow(/verdict=deny.*majority deny/);
  });

  test("defer raises StepFailure by default (fail-closed)", async () => {
    // Tie with no tiebreaker → defer.
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: denyOut() },
    });
    await expect(
      runSteps(tribunalStep({ seats: twoSeats }), { action: "x" }, options({ agentProvider: provider })),
    ).rejects.toThrow(/verdict=defer.*no tiebreaker configured/);
  });

  test("on_defer: continue lets the pipeline handle the defer downstream", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: denyOut() },
    });
    const result = await runSteps(
      tribunalStep({ seats: twoSeats, on_defer: "continue", collect: "ruling" }),
      { action: "x" },
      options({ agentProvider: provider }),
    );
    expect((result.ruling as TribunalVerdict).verdict).toBe("defer");
  });

  test("tie persisting after an abstaining tiebreaker defers", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: denyOut() },
      "lens.tiebreak": { output: "no comment" },
    });
    await expect(
      runSteps(
        tribunalStep({
          seats: twoSeats,
          tiebreaker: { name: "oracle", capability: "lens.tiebreak", prompt: "x" },
          on_defer: "fail",
        }),
        { action: "x" },
        options({ agentProvider: provider }),
      ),
    ).rejects.toThrow(/verdict=defer.*tie persisted after tiebreaker/);
  });

  test("confidence below bar defers", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut(0.3) },
      "lens.code": { output: allowOut(0.4) },
      "lens.injection": { output: allowOut(0.2) },
    });
    await expect(
      runSteps(
        tribunalStep({ seats: threeSeats, confidence_bar: 0.8 }),
        { action: "x" },
        options({ agentProvider: provider }),
      ),
    ).rejects.toThrow(/verdict=defer.*confidence bar/);
  });

  test("all-local-only panel downgrades allow to defer (diversity unsatisfiable)", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut(), model: "ollama-a" },
      "lens.code": { output: allowOut(), model: "ollama-b" },
    });
    const localSeats = twoSeats.map((s) => ({ ...s, sovereignty: { model_class: "local-only" as const } }));
    await expect(
      runSteps(tribunalStep({ seats: localSeats }), { action: "x" }, options({ agentProvider: provider })),
    ).rejects.toThrow(/verdict=defer.*diversity unsatisfiable/);
  });

  test("identical executing models downgrade allow to defer (post-hoc rule)", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut(), model: "same-model" },
      "lens.code": { output: allowOut(), model: "same-model" },
    });
    await expect(
      runSteps(tribunalStep({ seats: twoSeats }), { action: "x" }, options({ agentProvider: provider })),
    ).rejects.toThrow(/verdict=defer.*identical executing models/);
  });
});

describe("tribunal — dispatch mechanics", () => {
  test("seats dispatch concurrently, not sequentially", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut(), delayMs: 40 },
      "lens.code": { output: allowOut(), delayMs: 40 },
      "lens.injection": { output: allowOut(), delayMs: 40 },
    });
    const start = Date.now();
    await runSteps(tribunalStep({ seats: threeSeats }), { action: "x" }, options({ agentProvider: provider }));
    expect(provider.maxInFlight).toBeGreaterThanOrEqual(2);
    expect(Date.now() - start).toBeLessThan(100); // 3 × 40ms sequential would be ≥120ms
  });

  test("seat prompts render payload fields and carry the vote-format contract", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: allowOut() },
    });
    await runSteps(
      tribunalStep({ seats: twoSeats }),
      { action: "isolate host-42" },
      options({ agentProvider: provider }),
    );
    for (const d of provider.dispatched) {
      expect(d.prompt).toContain("Assess isolate host-42");
      expect(d.prompt).toMatch(/"verdict": "allow" \| "deny" \| "abstain"/);
    }
  });

  test("a failed seat becomes an abstain vote, not a panel crash", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: allowOut() },
      "lens.injection": { fail: "fleet unavailable" },
    });
    const result = await runSteps(
      tribunalStep({ seats: threeSeats }),
      { action: "x" },
      options({ agentProvider: provider }),
    );
    const verdict = result.tribunal_t as TribunalVerdict;
    expect(verdict.verdict).toBe("allow"); // 2 allow > 1 abstain + 0 deny
    const abstained = verdict.votes.find((v) => v.seat === "injection");
    expect(abstained?.verdict).toBe("abstain");
    expect(abstained?.abstain_cause).toBe("fleet unavailable");
  });

  test("a hung seat times out into an abstain — incapacitated panel denies", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { hang: true },
    });
    await expect(
      runSteps(
        tribunalStep({ seats: twoSeats, timeout_ms: 30 }),
        { action: "x" },
        options({ agentProvider: provider }),
      ),
    ).rejects.toThrow(/verdict=deny/); // 1 allow / 0 deny / 1 abstain → X ≥ A+D
  });

  test("parent abort cancels the panel with a step failure", async () => {
    const provider = new PanelProvider({
      "lens.security": { hang: true },
      "lens.code": { hang: true },
    });
    const controller = new AbortController();
    const pending = runSteps(
      tribunalStep({ seats: twoSeats }),
      { action: "x" },
      options({ agentProvider: provider, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  test("missing agentProvider fails fast with a clear error", async () => {
    await expect(runSteps(tribunalStep({ seats: twoSeats }), { action: "x" }, options())).rejects.toThrow(
      /no agentProvider configured/,
    );
  });

  test("retry primitive composes around a denying tribunal", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: denyOut() },
      "lens.code": { output: denyOut() },
    });
    const steps = [
      {
        retry: {
          attempts: 2,
          backoff: "constant" as const,
          initial_delay_ms: 1,
          actions: tribunalStep({ seats: twoSeats }),
        },
      },
    ];
    await expect(runSteps(steps, { action: "x" }, options({ agentProvider: provider }))).rejects.toThrow(
      StepFailure,
    );
    expect(provider.dispatched).toHaveLength(4); // 2 seats × 2 attempts
  });

  test("lifecycle events fire: convened, one per seat vote, verdict", async () => {
    const provider = new PanelProvider({
      "lens.security": { output: allowOut() },
      "lens.code": { output: allowOut() },
      "lens.injection": { output: allowOut() },
    });
    const events: TribunalEvent[] = [];
    await runSteps(
      tribunalStep({ seats: threeSeats }),
      { action: "x" },
      options({ agentProvider: provider, onTribunalEvent: (e) => events.push(e) }),
    );
    expect(events.filter((e) => e.type === "tribunal.convened")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tribunal.seat_voted")).toHaveLength(3);
    expect(events.filter((e) => e.type === "tribunal.verdict")).toHaveLength(1);
  });
});

describe("tribunal — validation", () => {
  test("rejects empty seats", () => {
    expect(() => validateStep({ tribunal: { name: "t", seats: [] } })).toThrow(/non-empty array/);
  });

  test("rejects missing name", () => {
    expect(() => validateStep({ tribunal: { seats: [{ name: "a", capability: "c", prompt: "p" }] } })).toThrow(
      /'name' must be a non-empty string/,
    );
  });

  test("rejects malformed seat with path-qualified error", () => {
    expect(() =>
      validateStep({ tribunal: { name: "t", seats: [{ name: "a", prompt: "p" }] } }),
    ).toThrow(/seats\[0\].*'capability'/);
  });

  test("rejects duplicate seat names", () => {
    const seat = { name: "a", capability: "c", prompt: "p" };
    expect(() => validateStep({ tribunal: { name: "t", seats: [seat, seat] } })).toThrow(/duplicate seat names/);
  });

  test("rejects out-of-range confidence_bar and bad on_defer", () => {
    const seats = [{ name: "a", capability: "c", prompt: "p" }];
    expect(() => validateStep({ tribunal: { name: "t", seats, confidence_bar: 1.5 } })).toThrow(/\[0, 1\]/);
    expect(() => validateStep({ tribunal: { name: "t", seats, on_defer: "ignore" } })).toThrow(/on_defer/);
  });

  test("rejects malformed tiebreaker", () => {
    const seats = [{ name: "a", capability: "c", prompt: "p" }];
    expect(() => validateStep({ tribunal: { name: "t", seats, tiebreaker: { name: "x" } } })).toThrow(
      /tiebreaker.*'capability'/,
    );
  });

  test("accepts a well-formed tribunal step", () => {
    expect(() =>
      validateStep({
        tribunal: {
          name: "containment",
          seats: [
            { name: "sec", capability: "lens.security", prompt: "p" },
            { name: "code", capability: "lens.code", prompt: "p" },
          ],
          tiebreaker: { name: "oracle", capability: "lens.adversarial", prompt: "p" },
          confidence_bar: 0.7,
          on_defer: "continue",
        },
      }),
    ).not.toThrow();
  });
});
