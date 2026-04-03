import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { discoverArcFlows } from "../src/lib/arc";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-flow-cli");

beforeAll(() => {
  // Package 1: has a flow with inline pipeline
  const pkg1Dir = join(TEST_DIR, "test-flow-pkg");
  mkdirSync(pkg1Dir, { recursive: true });
  writeFileSync(
    join(pkg1Dir, "arc-manifest.yaml"),
    "name: test-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );
  writeFileSync(
    join(pkg1Dir, "flow.yaml"),
    [
      "name: F_TEST_FLOW",
      'description: "A test flow for CLI testing"',
      "source:",
      "  type: inline",
      "destination:",
      "  type: stdout",
      "pipeline: ./pipeline.yaml",
    ].join("\n")
  );
  writeFileSync(
    join(pkg1Dir, "pipeline.yaml"),
    "name: P_TEST\ndescription: Test pipeline\nactions:\n  - A_DOUBLE\n"
  );

  // A_DOUBLE action inside the package
  const doubleDir = join(pkg1Dir, "A_DOUBLE");
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
        return { ...upstream, value, doubled: Number(value) * 2 };
      }
    };`
  );

  // Package 2: no flow.yaml
  const pkg2Dir = join(TEST_DIR, "no-flow-pkg");
  mkdirSync(pkg2Dir, { recursive: true });
  writeFileSync(
    join(pkg2Dir, "arc-manifest.yaml"),
    "name: no-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );

  // Package 3: second flow
  const pkg3Dir = join(TEST_DIR, "second-flow-pkg");
  mkdirSync(pkg3Dir, { recursive: true });
  writeFileSync(
    join(pkg3Dir, "arc-manifest.yaml"),
    "name: second-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );
  writeFileSync(
    join(pkg3Dir, "flow.yaml"),
    [
      "name: F_SECOND",
      "source:",
      "  type: inline",
      "destination:",
      "  type: stdout",
      "pipeline: ./pipeline.yaml",
    ].join("\n")
  );
  writeFileSync(
    join(pkg3Dir, "pipeline.yaml"),
    "name: P_SECOND\nactions:\n  - A_DOUBLE\n"
  );
  const doubleDir2 = join(pkg3Dir, "A_DOUBLE");
  mkdirSync(doubleDir2, { recursive: true });
  writeFileSync(
    join(doubleDir2, "action.json"),
    JSON.stringify({
      name: "A_DOUBLE",
      version: "1.0.0",
      description: "Double",
      input: {},
      output: {},
      requires: [],
    })
  );
  writeFileSync(
    join(doubleDir2, "action.ts"),
    `export default { async execute(input) { return { ...input, doubled: (input.value || 0) * 2 }; } };`
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("discoverArcFlows", () => {
  test("finds flows from packages with flow.yaml", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const names = flows.map((f) => f.flow.name).sort();
    expect(names).toContain("F_TEST_FLOW");
    expect(names).toContain("F_SECOND");
  });

  test("skips packages without flow.yaml", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const pkgNames = flows.map((f) => f.packageName);
    expect(pkgNames).not.toContain("no-flow-pkg");
  });

  test("includes metadata", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const testFlow = flows.find((f) => f.flow.name === "F_TEST_FLOW");
    expect(testFlow).toBeDefined();
    expect(testFlow!.packageName).toBe("test-flow-pkg");
    expect(testFlow!.yamlPath).toContain("flow.yaml");
    expect(testFlow!.baseDir).toContain("test-flow-pkg");
    expect(testFlow!.flow.description).toBe("A test flow for CLI testing");
  });

  test("returns empty for nonexistent directory", async () => {
    const flows = await discoverArcFlows("/nonexistent/repos");
    expect(flows).toEqual([]);
  });
});

describe("pulse flow CLI", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  test("pulse flow list runs without crashing", async () => {
    const proc = Bun.spawn(
      ["bun", cli, "flow", "list"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    // Smoke test: CLI is wired correctly and doesn't crash.
    // Actual flow discovery is tested by discoverArcFlows unit tests above.
    expect(proc.exitCode).toBe(0);
  });

  test("pulse flow run with nonexistent flow exits with error", async () => {
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", "F_NONEXISTENT"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("pulse flow run with yaml path and --dry-run validates", async () => {
    const flowYaml = join(TEST_DIR, "test-flow-pkg", "flow.yaml");
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", flowYaml, "--dry-run"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain("F_TEST_FLOW");
    expect(stdout).toContain("valid");
  });

  test("pulse flow run executes a flow from yaml path with passthrough args", async () => {
    const flowYaml = join(TEST_DIR, "test-flow-pkg", "flow.yaml");
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", flowYaml, "--value", "21"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stderr).toContain("completed");
    // stdout should contain the pipeline output (destination: stdout)
    expect(stdout).toContain("doubled");
  });
});
