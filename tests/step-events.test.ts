/**
 * P-802 — onStepEvent: plain-action step lifecycle events.
 * ISC-25..27 of the SOC demo plan (ISA.md, slug 2026-06-11-pulse-soc-demo-composer).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runPipeline } from "../src/lib/pipeline";
import type { StepEvent } from "../src/types/pipeline";

const TEST_DIR = join(import.meta.dir, ".test-step-events-actions");

function writeAction(name: string, body: string, output: Record<string, { type: string }>) {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "action.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: `test action ${name}`,
      input: {},
      output,
      requires: [],
    }),
  );
  writeFileSync(join(dir, "action.ts"), body);
}

beforeAll(() => {
  writeAction(
    "A_FIRST",
    `export default { async execute(input) { return { ...input, first: true }; } };`,
    { first: { type: "boolean" } },
  );
  writeAction(
    "A_SECOND",
    `export default { async execute(input) { return { ...input, second: true }; } };`,
    { second: { type: "boolean" } },
  );
  writeAction(
    "A_BOOM",
    `export default { async execute() { throw new Error("kaboom"); } };`,
    {},
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("onStepEvent (ISC-25/26)", () => {
  test("emits started/completed pairs in order for each plain action step", async () => {
    const events: StepEvent[] = [];
    const result = await runPipeline(
      { name: "P_TWO_STEPS", actions: ["A_FIRST", "A_SECOND"] },
      { seed: 1 },
      { actionDirs: [TEST_DIR], onStepEvent: (e) => events.push(e) },
    );

    expect(result.success).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
    ]);
    expect(events.map((e) => e.action)).toEqual(["A_FIRST", "A_FIRST", "A_SECOND", "A_SECOND"]);

    const completed = events[1] as Extract<StepEvent, { type: "step.completed" }>;
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.output_fields).toContain("first");

    const started = events[0] as Extract<StepEvent, { type: "step.started" }>;
    expect(Number.isNaN(Date.parse(started.started_at))).toBe(false);
  });

  test("emits step.failed with the error when an action throws", async () => {
    const events: StepEvent[] = [];
    const result = await runPipeline(
      { name: "P_FAILING", actions: ["A_FIRST", "A_BOOM", "A_SECOND"] },
      {},
      { actionDirs: [TEST_DIR], onStepEvent: (e) => events.push(e) },
    );

    expect(result.success).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
    ]);
    const failed = events[3] as Extract<StepEvent, { type: "step.failed" }>;
    expect(failed.action).toBe("A_BOOM");
    expect(failed.error).toContain("kaboom");
    // A_SECOND never started
    expect(events.some((e) => e.action === "A_SECOND")).toBe(false);
  });

  test("no sink configured — pipeline runs unchanged (backwards compatible)", async () => {
    const result = await runPipeline(
      { name: "P_SILENT", actions: ["A_FIRST"] },
      {},
      { actionDirs: [TEST_DIR] },
    );
    expect(result.success).toBe(true);
    expect(result.output?.first).toBe(true);
  });
});
