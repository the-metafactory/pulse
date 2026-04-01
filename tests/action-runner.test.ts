import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runAction, listActions } from "../src/lib/action-runner";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-actions");

beforeAll(() => {
  // Create test action: A_GREET
  const greetDir = join(TEST_DIR, "A_GREET");
  mkdirSync(greetDir, { recursive: true });

  writeFileSync(
    join(greetDir, "action.json"),
    JSON.stringify({
      name: "A_GREET",
      version: "1.0.0",
      description: "Greet a person",
      input: { name: { type: "string", required: true } },
      output: { greeting: { type: "string" } },
      requires: [],
    })
  );

  writeFileSync(
    join(greetDir, "action.ts"),
    `export default {
      async execute(input, ctx) {
        const { name, ...upstream } = input;
        return { ...upstream, greeting: "Hello, " + name + "!" };
      }
    };`
  );

  // Create test action: A_UPPERCASE
  const upperDir = join(TEST_DIR, "A_UPPERCASE");
  mkdirSync(upperDir, { recursive: true });

  writeFileSync(
    join(upperDir, "action.json"),
    JSON.stringify({
      name: "A_UPPERCASE",
      version: "1.0.0",
      description: "Uppercase the greeting",
      input: { greeting: { type: "string", required: true } },
      output: { greeting: { type: "string" }, uppercased: { type: "boolean" } },
      requires: [],
    })
  );

  writeFileSync(
    join(upperDir, "action.ts"),
    `export default {
      async execute(input, ctx) {
        const { greeting, ...upstream } = input;
        return { ...upstream, greeting: greeting.toUpperCase(), uppercased: true };
      }
    };`
  );

  // Create test action: A_SHELL (requires shell capability)
  const shellDir = join(TEST_DIR, "A_SHELL");
  mkdirSync(shellDir, { recursive: true });

  writeFileSync(
    join(shellDir, "action.json"),
    JSON.stringify({
      name: "A_SHELL",
      version: "1.0.0",
      description: "Run echo via shell",
      input: { message: { type: "string", required: true } },
      output: { stdout: { type: "string" } },
      requires: ["shell"],
    })
  );

  writeFileSync(
    join(shellDir, "action.ts"),
    `export default {
      async execute(input, ctx) {
        const { message, ...upstream } = input;
        const result = await ctx.capabilities.shell("echo " + JSON.stringify(message));
        return { ...upstream, stdout: result.stdout.trim() };
      }
    };`
  );

  // Create test action: A_FAIL (always throws)
  const failDir = join(TEST_DIR, "A_FAIL");
  mkdirSync(failDir, { recursive: true });

  writeFileSync(
    join(failDir, "action.json"),
    JSON.stringify({
      name: "A_FAIL",
      version: "1.0.0",
      description: "Always fails",
      input: {},
      output: {},
      requires: [],
    })
  );

  writeFileSync(
    join(failDir, "action.ts"),
    `export default {
      async execute() { throw new Error("intentional failure"); }
    };`
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const opts = { actionDirs: [TEST_DIR] };

describe("runAction", () => {
  test("executes a simple action", async () => {
    const result = await runAction("A_GREET", { name: "Jens-Christian" }, opts);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ greeting: "Hello, Jens-Christian!" });
    expect(result.metadata?.mode).toBe("local");
  });

  test("passthrough pattern preserves upstream data", async () => {
    const result = await runAction(
      "A_GREET",
      { name: "Daniel", extra: "preserved" },
      opts
    );
    expect(result.success).toBe(true);
    expect((result.output as any).greeting).toBe("Hello, Daniel!");
    expect((result.output as any).extra).toBe("preserved");
  });

  test("validates required inputs", async () => {
    const result = await runAction("A_GREET", {}, opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required input: name");
  });

  test("returns error for unknown action", async () => {
    const result = await runAction("A_NONEXISTENT", {}, opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("injects shell capability", async () => {
    const result = await runAction("A_SHELL", { message: "hello pulse" }, opts);
    expect(result.success).toBe(true);
    expect((result.output as any).stdout).toBe("hello pulse");
  });

  test("handles action errors gracefully", async () => {
    const result = await runAction("A_FAIL", {}, opts);
    expect(result.success).toBe(false);
    expect(result.error).toBe("intentional failure");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("includes timing metadata", async () => {
    const result = await runAction("A_GREET", { name: "test" }, opts);
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.action).toBe("A_GREET");
  });
});

describe("listActions", () => {
  test("lists all actions in directory", async () => {
    const actions = await listActions([TEST_DIR]);
    const names = actions.map((a) => a.name).sort();
    expect(names).toEqual(["A_FAIL", "A_GREET", "A_SHELL", "A_UPPERCASE"]);
  });

  test("returns empty for nonexistent directory", async () => {
    const actions = await listActions(["/nonexistent/path"]);
    expect(actions).toEqual([]);
  });
});
