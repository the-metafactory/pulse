import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runPipeline } from "../src/lib/pipeline";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-pipeline-actions");

beforeAll(() => {
  // A_EXTRACT: pulls "content" field, adds "extracted" and "word_count"
  const extractDir = join(TEST_DIR, "A_EXTRACT");
  mkdirSync(extractDir, { recursive: true });
  writeFileSync(
    join(extractDir, "action.json"),
    JSON.stringify({
      name: "A_EXTRACT",
      version: "1.0.0",
      description: "Extract and count words",
      input: { content: { type: "string", required: true } },
      output: { extracted: { type: "string" }, word_count: { type: "number" } },
      requires: [],
    })
  );
  writeFileSync(
    join(extractDir, "action.ts"),
    `export default {
      async execute(input) {
        const { content, ...payload } = input;
        return {
          ...payload,
          extracted: content.trim(),
          word_count: content.trim().split(/\\s+/).length,
        };
      }
    };`
  );

  // A_LABEL: reads "extracted", adds "label" and "confidence"
  const labelDir = join(TEST_DIR, "A_LABEL");
  mkdirSync(labelDir, { recursive: true });
  writeFileSync(
    join(labelDir, "action.json"),
    JSON.stringify({
      name: "A_LABEL",
      version: "1.0.0",
      description: "Label content",
      input: { extracted: { type: "string", required: true } },
      output: { label: { type: "string" }, confidence: { type: "number" } },
      requires: [],
    })
  );
  writeFileSync(
    join(labelDir, "action.ts"),
    `export default {
      async execute(input) {
        const { extracted, ...payload } = input;
        const label = extracted.length > 20 ? "long" : "short";
        return { ...payload, extracted, label, confidence: 0.95 };
      }
    };`
  );

  // A_FORMAT: reads accumulated fields, produces final "formatted" output
  const formatDir = join(TEST_DIR, "A_FORMAT");
  mkdirSync(formatDir, { recursive: true });
  writeFileSync(
    join(formatDir, "action.json"),
    JSON.stringify({
      name: "A_FORMAT",
      version: "1.0.0",
      description: "Format for output",
      input: {},
      output: { formatted: { type: "string" } },
      requires: [],
    })
  );
  writeFileSync(
    join(formatDir, "action.ts"),
    `export default {
      async execute(input) {
        const { extracted, label, word_count, confidence, ...payload } = input;
        return {
          ...payload,
          extracted, label, word_count, confidence,
          formatted: "[" + label + "] " + extracted + " (" + word_count + " words, " + (confidence * 100) + "% confidence)",
        };
      }
    };`
  );

  // A_BROKEN: fails mid-pipeline
  const brokenDir = join(TEST_DIR, "A_BROKEN");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(
    join(brokenDir, "action.json"),
    JSON.stringify({
      name: "A_BROKEN",
      version: "1.0.0",
      description: "Breaks the pipeline",
      input: {},
      output: {},
      requires: [],
    })
  );
  writeFileSync(
    join(brokenDir, "action.ts"),
    `export default { async execute() { throw new Error("broken"); } };`
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const opts = { actionDirs: [TEST_DIR] };

describe("Pipeline", () => {
  test("chains actions with passthrough accumulation", async () => {
    const result = await runPipeline(
      { name: "P_TEST", actions: ["A_EXTRACT", "A_LABEL", "A_FORMAT"] },
      { content: "Pulse is the execution engine for metafactory" },
      opts
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.success)).toBe(true);

    const output = result.output!;
    // All fields accumulated through the pipeline
    expect(output.extracted).toBe("Pulse is the execution engine for metafactory");
    expect(output.word_count).toBe(7);
    expect(output.label).toBe("long");
    expect(output.confidence).toBe(0.95);
    expect(output.formatted).toContain("[long]");
    expect(output.formatted).toContain("7 words");
  });

  test("initial input fields survive through entire pipeline", async () => {
    const result = await runPipeline(
      { name: "P_TEST", actions: ["A_EXTRACT", "A_LABEL"] },
      { content: "hello world", source: "test", timestamp: 12345 },
      opts
    );

    expect(result.success).toBe(true);
    const output = result.output!;
    // Original fields preserved through passthrough
    expect(output.source).toBe("test");
    expect(output.timestamp).toBe(12345);
    // Plus action outputs
    expect(output.word_count).toBe(2);
    expect(output.label).toBe("short");
  });

  test("stops on first action failure", async () => {
    const result = await runPipeline(
      { name: "P_FAIL", actions: ["A_EXTRACT", "A_BROKEN", "A_FORMAT"] },
      { content: "this will break" },
      opts
    );

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(2); // stopped at A_BROKEN
    expect(result.steps[0].success).toBe(true);
    expect(result.steps[1].success).toBe(false);
    expect(result.steps[1].error).toBe("broken");
  });

  test("single-action pipeline works", async () => {
    const result = await runPipeline(
      { name: "P_SINGLE", actions: ["A_EXTRACT"] },
      { content: "just one step" },
      opts
    );

    expect(result.success).toBe(true);
    expect(result.output?.word_count).toBe(3);
  });

  test("reports per-step timing", async () => {
    const result = await runPipeline(
      { name: "P_TIMED", actions: ["A_EXTRACT", "A_LABEL"] },
      { content: "measure this" },
      opts
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    for (const step of result.steps) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
