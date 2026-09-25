import { describe, expect, test } from "bun:test";
import { checkToolArgs, fieldSchema, prepareInput, toolInput, toolSchema } from "../src/lib/tool-schema";
import { createLocalShell } from "../src/lib/capabilities";
import { evaluate } from "../src/lib/enforcement-gate";
import { shellGateInput } from "../src/lib/policy-loader";
import type { ActionManifest } from "../src/types/action";
import type { Policy } from "../src/types/policy";

const manifest = (input: ActionManifest["input"]): ActionManifest => ({
  name: "A_T",
  version: "1.0.0",
  description: "t",
  input,
  output: {},
});

describe("toolSchema — an action manifest as a tool definition", () => {
  test("legacy {type, required} fields become a plain schema", () => {
    const schema = toolSchema(manifest({ url: { type: "string", required: true }, n: { type: "number" } }));
    expect(schema).toEqual({
      type: "object",
      properties: { url: { type: "string" }, n: { type: "number" } },
      required: ["url"],
      additionalProperties: false,
    });
  });

  test("JSON Schema keywords pass through; string[] becomes an array of strings", () => {
    expect(fieldSchema({ type: "string", required: true, description: "d", enum: ["a", "b"], default: "a" })).toEqual({
      type: "string",
      description: "d",
      enum: ["a", "b"],
      default: "a",
    });
    expect(fieldSchema({ type: "string[]" })).toEqual({ type: "array", items: { type: "string" } });
    expect(fieldSchema({ type: "array", items: { type: "integer" } })).toEqual({ type: "array", items: { type: "integer" } });
  });

  test("bound fields leave the schema and its required list", () => {
    const schema = toolSchema(manifest({ q: { type: "string", required: true }, account: { type: "string", required: true } }), { account: "x" });
    expect(Object.keys(schema.properties)).toEqual(["q"]);
    expect(schema.required).toEqual(["q"]);
  });

  test("toolInput keeps declared fields only and forces bound values", () => {
    const m = manifest({ q: { type: "string" }, account: { type: "string" } });
    expect(toolInput(m, { q: "hi", account: "evil", extra: 1 }, { account: "pinned" })).toEqual({ q: "hi", account: "pinned" });
  });
});

describe("prepareInput — defaults and enums", () => {
  test("fills defaults, checks required and enum", () => {
    const m = manifest({ n: { type: "integer", default: 10 }, mode: { type: "string", enum: ["a", "b"] }, q: { type: "string", required: true } });
    expect(prepareInput(m, { q: "x" })).toEqual({ input: { q: "x", n: 10 } });
    expect(prepareInput(m, {}).error).toBe("Missing required input: q");
    expect(prepareInput(m, { q: "x", mode: "c" }).error).toBe("Input mode must be one of: a, b");
  });

  test("a legacy manifest passes input through unchanged", () => {
    const m = manifest({ url: { type: "string", required: true } });
    expect(prepareInput(m, { url: "u", other: 1 })).toEqual({ input: { url: "u", other: 1 } });
  });
});

describe("shell — argv form", () => {
  test("argv runs without a shell: syntax stays literal", async () => {
    const shell = createLocalShell();
    const r = await shell(["echo", "$(whoami); echo x"]);
    expect(r.stdout.trim()).toBe("$(whoami); echo x");
  });

  test("the string form still runs through sh -c", async () => {
    const r = await createLocalShell()("echo a; echo b");
    expect(r.stdout.trim().split("\n")).toEqual(["a", "b"]);
  });

  test("argvOnly refuses the string form; empty argv is refused", async () => {
    const shell = createLocalShell(true);
    await expect(shell("echo hi")).rejects.toThrow(/string form \(sh -c\) is refused/);
    await expect(shell([])).rejects.toThrow(/non-empty array/);
    expect((await shell(["echo", "ok"])).stdout.trim()).toBe("ok");
  });
});

describe("shellGateInput — what the policy gate matches", () => {
  test("argv form carries form, program, argv and a quoted command", () => {
    expect(shellGateInput(["grep", "-r", "a b", "it's"])).toEqual({
      command: `grep -r 'a b' 'it'\\''s'`,
      form: "argv",
      program: "grep",
      argv: ["grep", "-r", "a b", "it's"],
    });
    expect(shellGateInput("ls -la")).toEqual({ command: "ls -la", form: "string" });
  });

  test("a policy can pin the program and refuse sh -c; old command rules still match", () => {
    const policy: Policy = {
      version: 1,
      default: "deny",
      rules: [
        { tool: "Bash", match: { form: "^string$" }, decision: "deny" },
        { tool: "Bash", match: { program: "^/usr/bin/tool$" }, decision: "allow" },
      ],
    };
    expect(evaluate("Bash", shellGateInput(["/usr/bin/tool", "x"]), policy).decision).toBe("allow");
    expect(evaluate("Bash", shellGateInput(["/usr/bin/other", "x"]), policy).decision).toBe("deny");
    expect(evaluate("Bash", shellGateInput("/usr/bin/tool x"), policy).decision).toBe("deny");

    const legacy: Policy = { version: 1, default: "deny", rules: [{ tool: "Bash", match: { command: "^echo " }, decision: "allow" }] };
    expect(evaluate("Bash", shellGateInput(["echo", "hi"]), legacy).decision).toBe("allow");
    expect(evaluate("Bash", shellGateInput("echo hi"), legacy).decision).toBe("allow");
  });
});

describe("checkToolArgs — model arguments against the schema it was shown", () => {
  const m = manifest({
    q: { type: "string", required: true, maxLength: 5 },
    n: { type: "integer", minimum: 1, maximum: 25 },
    mode: { type: "string", enum: ["a", "b"] },
    tags: { type: "string[]", maxItems: 2 },
    account: { type: "string" },
  });

  test("values inside the schema pass; unset and optional null fields are skipped", () => {
    expect(checkToolArgs(m, { q: "hi", n: 25, mode: "a", tags: ["x"] })).toBeUndefined();
    expect(checkToolArgs(m, { q: "hi", n: null })).toBeUndefined();
  });

  test("type, bounds, length, enum, item count and item type are enforced", () => {
    expect(checkToolArgs(m, { q: 1 })).toBe("q must be string");
    expect(checkToolArgs(m, { q: "toolong" })).toBe("q must have at most 5 characters");
    expect(checkToolArgs(m, { n: 1.5 })).toBe("n must be integer");
    expect(checkToolArgs(m, { n: 0 })).toBe("n must be >= 1");
    expect(checkToolArgs(m, { n: 26 })).toBe("n must be <= 25");
    expect(checkToolArgs(m, { mode: "c" })).toBe("mode must be one of: a, b");
    expect(checkToolArgs(m, { tags: ["a", "b", "c"] })).toBe("tags must have at most 2 items");
    expect(checkToolArgs(m, { tags: ["a", 2] })).toBe("tags[1] must be string");
  });

  test("a bound field is not the model's to set, so it is not checked", () => {
    expect(checkToolArgs(m, { account: 42 }, { account: "pinned" })).toBeUndefined();
  });
});
