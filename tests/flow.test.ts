import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runFlow, scheduleFlow, loadFlow } from "../src/lib/flow";
import type { FlowResult } from "../src/types/flow";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-flow-actions");
const OUTPUT_DIR = join(import.meta.dir, ".test-flow-output");

beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // A_DOUBLE action: doubles a number
  const doubleDir = join(TEST_DIR, "A_DOUBLE");
  mkdirSync(doubleDir, { recursive: true });
  writeFileSync(
    join(doubleDir, "action.json"),
    JSON.stringify({
      name: "A_DOUBLE",
      version: "1.0.0",
      description: "Double a value",
      input: { value: { type: "number", required: true } },
      output: { doubled: { type: "number" } },
      requires: [],
    })
  );
  writeFileSync(
    join(doubleDir, "action.ts"),
    `export default {
      async execute(input) {
        const { value, ...upstream } = input;
        return { ...upstream, value, doubled: value * 2 };
      }
    };`
  );

  // A_FORMAT_RESULT action: format as string
  const formatDir = join(TEST_DIR, "A_FORMAT_RESULT");
  mkdirSync(formatDir, { recursive: true });
  writeFileSync(
    join(formatDir, "action.json"),
    JSON.stringify({
      name: "A_FORMAT_RESULT",
      version: "1.0.0",
      description: "Format result as digest",
      input: { doubled: { type: "number", required: true } },
      output: { digest: { type: "string" } },
      requires: [],
    })
  );
  writeFileSync(
    join(formatDir, "action.ts"),
    `export default {
      async execute(input) {
        const { doubled, ...upstream } = input;
        return { ...upstream, doubled, digest: "Result: " + doubled };
      }
    };`
  );

  // A_FAIL action
  const failDir = join(TEST_DIR, "A_FAIL");
  mkdirSync(failDir, { recursive: true });
  writeFileSync(
    join(failDir, "action.json"),
    JSON.stringify({
      name: "A_FAIL", version: "1.0.0", description: "Always fails",
      input: {}, output: {}, requires: [],
    })
  );
  writeFileSync(
    join(failDir, "action.ts"),
    `export default { async execute() { throw new Error("action failed"); } };`
  );

  // pipeline.yaml for YAML-based flow test
  const pipeDir = join(TEST_DIR, "P_DOUBLE_FORMAT");
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(
    join(pipeDir, "pipeline.yaml"),
    `name: P_DOUBLE_FORMAT\ndescription: Double then format\nactions:\n  - A_DOUBLE\n  - A_FORMAT_RESULT\n`
  );
  // Symlink actions into pipeline dir
  const doubleLink = join(pipeDir, "A_DOUBLE");
  const formatLink = join(pipeDir, "A_FORMAT_RESULT");
  if (!existsSync(doubleLink)) {
    const { execSync } = require("child_process");
    execSync(`ln -s ${join(TEST_DIR, "A_DOUBLE")} ${doubleLink}`);
    execSync(`ln -s ${join(TEST_DIR, "A_FORMAT_RESULT")} ${formatLink}`);
  }
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

describe("runFlow", () => {
  test("inline source → inline pipeline → stdout destination", async () => {
    const result = await runFlow(
      {
        name: "F_TEST_INLINE",
        source: { type: "inline", data: { value: 21 } },
        pipeline: { actions: ["A_DOUBLE", "A_FORMAT_RESULT"] },
        destination: { type: "stdout" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(result.flowName).toBe("F_TEST_INLINE");
    expect(result.pipelineOutput?.doubled).toBe(42);
    expect(result.pipelineOutput?.digest).toBe("Result: 42");
    expect(result.destinationWritten).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.completedAt).toBeDefined();
  });

  test("inline source → pipeline → file destination (JSON)", async () => {
    const outPath = join(OUTPUT_DIR, "result.json");

    const result = await runFlow(
      {
        name: "F_TEST_FILE",
        source: { type: "inline", data: { value: 5 } },
        pipeline: { actions: ["A_DOUBLE", "A_FORMAT_RESULT"] },
        destination: { type: "file", path: outPath, format: "json" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(result.destinationWritten).toBe(true);

    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written.doubled).toBe(10);
    expect(written.digest).toBe("Result: 10");
  });

  test("inline source → pipeline → file destination (markdown)", async () => {
    const outPath = join(OUTPUT_DIR, "result.md");

    const result = await runFlow(
      {
        name: "F_TEST_MD",
        source: { type: "inline", data: { value: 7 } },
        pipeline: { actions: ["A_DOUBLE", "A_FORMAT_RESULT"] },
        destination: { type: "file", path: outPath, format: "markdown" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    const written = readFileSync(outPath, "utf-8");
    expect(written).toBe("Result: 14");
  });

  test("file source → pipeline", async () => {
    const inputPath = join(OUTPUT_DIR, "input.json");
    writeFileSync(inputPath, JSON.stringify({ value: 100 }));

    const result = await runFlow(
      {
        name: "F_TEST_FILE_SOURCE",
        source: { type: "file", path: inputPath },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "stdout" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(result.pipelineOutput?.doubled).toBe(200);
  });

  test("custom source function", async () => {
    const result = await runFlow(
      {
        name: "F_CUSTOM_SOURCE",
        source: { type: "custom", fn: async () => ({ value: 33 }) },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "stdout" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(result.pipelineOutput?.doubled).toBe(66);
  });

  test("custom destination function", async () => {
    let captured: Record<string, unknown> | undefined;

    const result = await runFlow(
      {
        name: "F_CUSTOM_DEST",
        source: { type: "inline", data: { value: 4 } },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "custom", fn: async (output) => { captured = output; } },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(captured?.doubled).toBe(8);
  });

  test("static input merges with source data", async () => {
    const result = await runFlow(
      {
        name: "F_MERGE_INPUT",
        source: { type: "inline", data: { value: 10 } },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "stdout" },
        input: { extra: "preserved" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(true);
    expect(result.pipelineOutput?.doubled).toBe(20);
    expect(result.pipelineOutput?.extra).toBe("preserved");
  });

  test("reports source failure with failedStage", async () => {
    const result = await runFlow(
      {
        name: "F_BAD_SOURCE",
        source: { type: "file", path: "/nonexistent/input.json" },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "stdout" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("source");
    expect(result.error).toContain("not found");
  });

  test("reports pipeline failure with failedStage", async () => {
    const result = await runFlow(
      {
        name: "F_BAD_PIPELINE",
        source: { type: "inline", data: { value: 1 } },
        pipeline: { actions: ["A_FAIL"] },
        destination: { type: "stdout" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("pipeline");
    expect(result.error).toContain("action failed");
  });

  test("reports destination failure with failedStage", async () => {
    const result = await runFlow(
      {
        name: "F_BAD_DEST",
        source: { type: "inline", data: { value: 1 } },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "webhook", url: "http://localhost:1/nonexistent" },
      },
      { actionDirs: [TEST_DIR] }
    );

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("destination");
  });

  test("pipeline from YAML path", async () => {
    const result = await runFlow(
      {
        name: "F_YAML_PIPELINE",
        source: { type: "inline", data: { value: 3 } },
        pipeline: join(TEST_DIR, "P_DOUBLE_FORMAT", "pipeline.yaml"),
        destination: { type: "stdout" },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.pipelineOutput?.doubled).toBe(6);
    expect(result.pipelineOutput?.digest).toBe("Result: 6");
  });
});

describe("scheduleFlow", () => {
  test("runs immediately and on interval, then stops", async () => {
    const runs: FlowResult[] = [];

    const { stop } = scheduleFlow(
      {
        name: "F_SCHEDULED",
        source: { type: "inline", data: { value: 1 } },
        pipeline: { actions: ["A_DOUBLE"] },
        destination: { type: "stdout" },
        schedule: { intervalSeconds: 0.1 },
      },
      {
        actionDirs: [TEST_DIR],
        onRun: (result) => runs.push(result),
      }
    );

    // Wait for initial + at least one interval
    await new Promise((r) => setTimeout(r, 250));
    stop();

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.success)).toBe(true);
  });

  test("throws without schedule", () => {
    expect(() =>
      scheduleFlow(
        {
          name: "F_NO_SCHEDULE",
          source: { type: "inline", data: {} },
          pipeline: { actions: [] },
          destination: { type: "stdout" },
        },
        { actionDirs: [] }
      )
    ).toThrow("no schedule");
  });
});

describe("loadFlow", () => {
  test("loads flow from YAML", async () => {
    const flowPath = join(OUTPUT_DIR, "test-flow.yaml");
    writeFileSync(
      flowPath,
      `name: F_TEST
description: A test flow
source:
  type: inline
destination:
  type: stdout
pipeline: ./pipeline.yaml
`
    );

    const flow = await loadFlow(flowPath);
    expect(flow.name).toBe("F_TEST");
    expect(flow.description).toBe("A test flow");
    expect((flow.source as any).type).toBe("inline");
    expect(flow.destination).toEqual({ type: "stdout" });
  });

  test("throws on missing file", async () => {
    await expect(loadFlow("/nonexistent/flow.yaml")).rejects.toThrow("not found");
  });
});
