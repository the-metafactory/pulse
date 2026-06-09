import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { loadPipeline, runPipelineFromYaml, discoverPipelines } from "../src/lib/pipeline";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-yaml-pipelines");

beforeAll(() => {
  // Create a pipeline package: P_GREET_FORMAT
  const pipeDir = join(TEST_DIR, "P_GREET_FORMAT");
  mkdirSync(pipeDir, { recursive: true });

  writeFileSync(
    join(pipeDir, "pipeline.yaml"),
    `name: P_GREET_FORMAT
description: Greet then format
actions:
  - A_GREET
  - A_FORMAT
`
  );

  // A_GREET action
  const greetDir = join(pipeDir, "A_GREET");
  mkdirSync(greetDir, { recursive: true });
  writeFileSync(
    join(greetDir, "action.json"),
    JSON.stringify({
      name: "A_GREET",
      version: "1.0.0",
      description: "Greet",
      input: { name: { type: "string", required: true } },
      output: { greeting: { type: "string" } },
      requires: [],
    })
  );
  writeFileSync(
    join(greetDir, "action.ts"),
    `export default {
      async execute(input) {
        const { name, ...payload } = input;
        return { ...payload, greeting: "Hello, " + name + "!" };
      }
    };`
  );

  // A_FORMAT action
  const formatDir = join(pipeDir, "A_FORMAT");
  mkdirSync(formatDir, { recursive: true });
  writeFileSync(
    join(formatDir, "action.json"),
    JSON.stringify({
      name: "A_FORMAT",
      version: "1.0.0",
      description: "Format greeting as markdown",
      input: { greeting: { type: "string", required: true } },
      output: { formatted: { type: "string" } },
      requires: [],
    })
  );
  writeFileSync(
    join(formatDir, "action.ts"),
    `export default {
      async execute(input) {
        const { greeting, ...payload } = input;
        return { ...payload, greeting, formatted: "**" + greeting + "**" };
      }
    };`
  );

  // Create a second pipeline for discovery test
  const pipe2Dir = join(TEST_DIR, "P_SIMPLE");
  mkdirSync(pipe2Dir, { recursive: true });
  writeFileSync(
    join(pipe2Dir, "pipeline.yaml"),
    `name: P_SIMPLE
description: Just one step
actions:
  - A_GREET
`
  );
  // A_GREET action in second pipeline
  const greet2Dir = join(pipe2Dir, "A_GREET");
  mkdirSync(greet2Dir, { recursive: true });
  writeFileSync(join(greet2Dir, "action.json"), JSON.stringify({
    name: "A_GREET", version: "1.0.0", description: "Greet",
    input: { name: { type: "string", required: true } },
    output: { greeting: { type: "string" } }, requires: [],
  }));
  writeFileSync(join(greet2Dir, "action.ts"),
    `export default { async execute(input) { const { name, ...u } = input; return { ...u, greeting: "Hi " + name }; } };`
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadPipeline", () => {
  test("loads pipeline.yaml with name and actions", async () => {
    const { pipeline, baseDir } = await loadPipeline(
      join(TEST_DIR, "P_GREET_FORMAT", "pipeline.yaml")
    );
    expect(pipeline.name).toBe("P_GREET_FORMAT");
    expect(pipeline.actions).toEqual(["A_GREET", "A_FORMAT"]);
    expect(pipeline.description).toBe("Greet then format");
    expect(baseDir).toContain("P_GREET_FORMAT");
  });

  test("throws on missing file", async () => {
    await expect(loadPipeline("/nonexistent/pipeline.yaml")).rejects.toThrow("not found");
  });

  test("throws on missing name", async () => {
    const badDir = join(TEST_DIR, "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "pipeline.yaml"), "actions:\n  - A_FOO\n");
    await expect(loadPipeline(join(badDir, "pipeline.yaml"))).rejects.toThrow("missing required 'name'");
    rmSync(badDir, { recursive: true });
  });

  test("throws on missing actions", async () => {
    const badDir = join(TEST_DIR, "bad2");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "pipeline.yaml"), "name: P_BAD\n");
    await expect(loadPipeline(join(badDir, "pipeline.yaml"))).rejects.toThrow("missing or empty 'actions'");
    rmSync(badDir, { recursive: true });
  });
});

describe("runPipelineFromYaml", () => {
  test("loads and runs pipeline from YAML", async () => {
    const result = await runPipelineFromYaml(
      join(TEST_DIR, "P_GREET_FORMAT", "pipeline.yaml"),
      { name: "Daniel" },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.output?.greeting).toBe("Hello, Daniel!");
    expect(result.output?.formatted).toBe("**Hello, Daniel!**");
  });

  test("passthrough preserves initial input through YAML pipeline", async () => {
    const result = await runPipelineFromYaml(
      join(TEST_DIR, "P_GREET_FORMAT", "pipeline.yaml"),
      { name: "Jens-Christian", source: "test", id: 42 },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.output?.source).toBe("test");
    expect(result.output?.id).toBe(42);
    expect(result.output?.formatted).toContain("Jens-Christian");
  });
});

describe("discoverPipelines", () => {
  test("finds all pipelines in directory", async () => {
    const pipelines = await discoverPipelines(TEST_DIR);
    const names = pipelines.map((p) => p.pipeline.name).sort();
    expect(names).toEqual(["P_GREET_FORMAT", "P_SIMPLE"]);
  });

  test("returns empty for nonexistent directory", async () => {
    const pipelines = await discoverPipelines("/nonexistent");
    expect(pipelines).toEqual([]);
  });
});
