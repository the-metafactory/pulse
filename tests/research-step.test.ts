import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { runPipeline } from "../src/lib/pipeline";
import { validateStep } from "../src/lib/step-runner";
import { OpenAICompatibleChatModel, ModelUnavailableError, type ChatModel } from "../src/lib/chat-model";
import { ResearchUnavailable } from "../src/lib/research";
import type { ResearchEvent } from "../src/types/research";
import type { StepRecord } from "../src/lib/step-runner";
import type { Policy } from "../src/types/policy";

const DIR = join(import.meta.dir, ".test-research");
const ACTIONS = join(DIR, "actions");
const TRACES = join(DIR, "traces");
const MARKER = join(DIR, "marker.txt");
const KEY_ENV = "PULSE_TEST_RESEARCH_KEY";
const KEY = "sk-test-secret-123";

function createAction(name: string, manifest: Record<string, unknown>, code: string) {
  const dir = join(ACTIONS, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "action.json"), JSON.stringify({ name, version: "1.0.0", description: `${name} test action`, output: {}, ...manifest }));
  writeFileSync(join(dir, "action.ts"), code);
}

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible server: scripted replies, every request recorded
// ---------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown; raw?: string };
let script: Reply[] = [];
let requests: any[] = [];
let headers: Headers[] = [];
let server: ReturnType<typeof Bun.serve>;

const toolCall = (id: string, name: string, args: Record<string, unknown> | string) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const reply = (message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5 }): Reply => ({
  body: { choices: [{ message: { role: "assistant", content: null, ...message }, finish_reason: "stop" }], usage },
});

function model(extra: Partial<ConstructorParameters<typeof OpenAICompatibleChatModel>[0]> = {}): ChatModel {
  return new OpenAICompatibleChatModel({
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: "test-alias",
    apiKeyEnv: KEY_ENV,
    env: { [KEY_ENV]: KEY },
    ...extra,
  });
}

function pipeline(research: Record<string, unknown>, before: string[] = ["A_SEED"]) {
  return {
    name: "P_TEST",
    actions: [...before, { research: { name: "prep", model: "m", prompt: "Prepare {topic}", tools: ["A_LOOKUP"], ...research } }],
  } as any;
}

beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(ACTIONS, { recursive: true });

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.json());
      headers.push(req.headers);
      const next = script.shift() ?? { status: 500, raw: "script exhausted" };
      if (next.raw !== undefined) return new Response(next.raw, { status: next.status ?? 200 });
      return Response.json(next.body, { status: next.status ?? 200 });
    },
  });

  createAction("A_SEED", { input: {}, output: { topic: { type: "string" } } }, `export default {
    async execute(input) {
      await Bun.write(${JSON.stringify(MARKER)}, "seed ran");
      return { ...input, topic: "the quarterly review" };
    }
  };`);

  createAction("A_LOOKUP", {
    effect: "read",
    input: {
      query: { type: "string", required: true, description: "words to match" },
      account: { type: "string", required: true, enum: ["alpha", "beta"] },
      limit: { type: "integer", default: 5 },
      tags: { type: "string[]" },
    },
    output: { text: { type: "string" } },
  }, `export default {
    async execute(input) {
      return { text: "found " + input.query + " in " + input.account + " limit " + input.limit };
    }
  };`);

  createAction("A_OTHER", { effect: "read", input: { q: { type: "string" } }, output: { rows: { type: "array" } } }, `export default {
    async execute(input) { return { rows: [input.q, input.q] }; }
  };`);

  createAction("A_SEND", { effect: "write", input: { to: { type: "string" } }, output: {} }, `export default {
    async execute() { return { sent: true }; }
  };`);

  createAction("A_UNDECLARED", { input: { q: { type: "string" } }, output: {} }, `export default {
    async execute() { return {}; }
  };`);

  createAction("A_SHELL_STRING", { effect: "read", requires: ["shell"], input: { q: { type: "string" } }, output: { out: { type: "string" } } }, `export default {
    async execute(input, ctx) {
      const r = await ctx.capabilities.shell("echo " + input.q);
      return { out: r.stdout };
    }
  };`);

  createAction("A_SHELL_ARGV", { effect: "read", requires: ["shell"], input: { q: { type: "string" } }, output: { out: { type: "string" } } }, `export default {
    async execute(input, ctx) {
      const r = await ctx.capabilities.shell(["echo", input.q]);
      return { out: r.stdout.trim() };
    }
  };`);
});

afterAll(() => {
  server.stop(true);
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  script = [];
  requests = [];
  headers = [];
  rmSync(MARKER, { force: true });
  rmSync(TRACES, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("research step — parse-time shape", () => {
  test("accepts a well-formed step", () => {
    expect(() => validateStep({ research: { name: "r", model: "m", prompt: "p", tools: ["A_X"] } })).not.toThrow();
  });

  test("rejects missing tools, bad tool names, bad bind and bad numbers", () => {
    expect(() => validateStep({ research: { name: "r", model: "m", prompt: "p", tools: [] } })).toThrow(/tools/);
    expect(() => validateStep({ research: { name: "r", model: "m", prompt: "p", tools: ["a b"] } })).toThrow(/not a valid action name/);
    expect(() => validateStep({ research: { name: "r", model: "m", prompt: "p", tools: ["A"], bind: ["x"] } })).toThrow(/bind/);
    expect(() => validateStep({ research: { name: "r", model: "m", prompt: "p", tools: ["A"], max_rounds: 0 } })).toThrow(/max_rounds/);
    expect(() => validateStep({ research: { name: "r", prompt: "p", tools: ["A"] } })).toThrow(/model/);
  });
});

describe("research step — the never-list is checked before anything runs", () => {
  test("a write tool fails the pipeline before its first step runs", async () => {
    const result = await runPipeline(pipeline({ tools: ["A_LOOKUP", "A_SEND"] }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/A_SEND is effect write/);
    expect(existsSync(MARKER)).toBe(false);
    expect(requests.length).toBe(0);
  });

  test("an action without a declared effect counts as not read", async () => {
    const result = await runPipeline(pipeline({ tools: ["A_UNDECLARED"] }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.error).toMatch(/A_UNDECLARED is effect undeclared/);
    expect(existsSync(MARKER)).toBe(false);
  });

  test("a research step nested in map is preflighted too", async () => {
    const nested = {
      name: "P_NESTED",
      actions: ["A_SEED", { map: { over: "items", as: "item", collect: "out", actions: [{ research: { name: "r", model: "m", prompt: "p", tools: ["A_SEND"] } }] } }],
    } as any;
    const result = await runPipeline(nested, { items: [1] }, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.success).toBe(false);
    expect(existsSync(MARKER)).toBe(false);
  });

  test("a bind key no tool declares is refused (a typo would unpin a field)", async () => {
    const result = await runPipeline(pipeline({ bind: { acount: "alpha" } }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.error).toMatch(/bind field 'acount'/);
    expect(existsSync(MARKER)).toBe(false);
  });

  test("the step re-checks at run time when driven without runPipeline", async () => {
    const { runSteps } = await import("../src/lib/step-runner");
    const records: StepRecord[] = [];
    await expect(
      runSteps([{ research: { name: "r", model: "m", prompt: "p", tools: ["A_SEND"] } }], {}, { actionDirs: [ACTIONS], models: { m: model() } }, records),
    ).rejects.toThrow(/effect write/);
    expect(requests.length).toBe(0);
  });
});

describe("research step — tools, bind and the loop", () => {
  test("bound fields are hidden from the model and forced onto every call", async () => {
    script = [
      reply({ tool_calls: [toolCall("c1", "A_LOOKUP", { query: "budget", account: "beta", smuggled: "x" })] }),
      reply({ content: "The prep." }),
    ];
    const result = await runPipeline(pipeline({ bind: { account: "alpha" } }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.success).toBe(true);
    expect(result.output!.research_prep).toBe("The prep.");

    const params = requests[0].tools[0].function.parameters;
    expect(Object.keys(params.properties)).toEqual(["query", "limit", "tags"]);
    expect(params.required).toEqual(["query"]);
    expect(params.properties.query.description).toBe("words to match");
    expect(params.properties.limit.default).toBe(5);
    expect(params.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(requests[0].tools[0].function.description).toBe("A_LOOKUP test action");

    // The tool result the model saw: bound account, declared default, no smuggled field.
    expect(requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "found budget in alpha limit 5" });
  });

  test("the prompt renders from the payload and the key goes out as a bearer token", async () => {
    script = [reply({ content: "ok" })];
    await runPipeline(pipeline({ system: "You prepare {topic}." }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(requests[0].messages).toEqual([
      { role: "system", content: "You prepare the quarterly review." },
      { role: "user", content: "Prepare the quarterly review" },
    ]);
    expect(requests[0].model).toBe("test-alias");
    expect(requests[0].tool_choice).toBe("auto");
    expect(headers[0].get("authorization")).toBe(`Bearer ${KEY}`);
  });

  test("the round cap ends research with a write turn that carries no tools field", async () => {
    script = [
      reply({ tool_calls: [toolCall("c1", "A_LOOKUP", { query: "a" })] }),
      reply({ tool_calls: [toolCall("c2", "A_LOOKUP", { query: "b" })] }),
      reply({ content: "Written." }),
    ];
    const result = await runPipeline(pipeline({ max_rounds: 2, write_prompt: "Write now." }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.output!.research_prep).toBe("Written.");
    expect(requests.length).toBe(3);
    expect("tools" in requests[2]).toBe(false);
    expect("tool_choice" in requests[2]).toBe(false);
    expect(requests[2].messages.at(-1)).toEqual({ role: "user", content: "Write now." });
  });

  test("an empty answer earns write turns up to empty_retries, then fails", async () => {
    script = [reply({ content: null }), reply({ content: "  " }), reply({ content: "Finally." })];
    const ok = await runPipeline(pipeline({}), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(ok.output!.research_prep).toBe("Finally.");
    expect("tools" in requests[1]).toBe(false);

    requests = [];
    script = [reply({ content: null }), reply({ content: null })];
    const bad = await runPipeline(pipeline({ empty_retries: 1 }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/empty answer after 1 retries/);
    expect(requests.length).toBe(2);
  });

  test("duplicate calls, unknown tools and bad arguments are answered, not run", async () => {
    script = [
      reply({
        tool_calls: [
          toolCall("c1", "A_OTHER", { q: "x" }),
          toolCall("c2", "A_OTHER", { q: "x" }),
          toolCall("c3", "A_SEND", { to: "someone" }),
          toolCall("c4", "A_OTHER", "{not json"),
        ],
      }),
      reply({ content: "done" }),
    ];
    const events: ResearchEvent[] = [];
    const result = await runPipeline(pipeline({ tools: ["A_LOOKUP", "A_OTHER"] }), {}, {
      actionDirs: [ACTIONS],
      models: { m: model() },
      onResearchEvent: (e) => events.push(e),
    });
    expect(result.success).toBe(true);
    const toolMsgs = requests[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(toolMsgs).toEqual([
      JSON.stringify({ rows: ["x", "x"] }),
      "(duplicate call; see the earlier result)",
      "unknown tool A_SEND",
      "tool error: arguments are not valid JSON",
    ]);
    const completed = events.find((e) => e.type === "research.completed") as Extract<ResearchEvent, { type: "research.completed" }>;
    expect(completed.stats.duplicates).toBe(1);
    expect(completed.stats.tool_calls).toEqual({ A_OTHER: 2 });
    expect(completed.stats.tokens_in).toBe(20);
    // Events carry names and counts only, never arguments or results.
    expect(JSON.stringify(events)).not.toContain("someone");
  });

  test("results are clipped to result_chars; collect names the field", async () => {
    script = [reply({ tool_calls: [toolCall("c1", "A_LOOKUP", { query: "q".repeat(100) })] }), reply({ content: "ok" })];
    const result = await runPipeline(pipeline({ result_chars: 20, collect: "prep", bind: { account: "alpha" } }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(result.output!.prep).toBe("ok");
    expect(requests[1].messages.at(-1).content).toBe(`${"found " + "q".repeat(14)}\n[… truncated]`);
  });
});

describe("research step — argv shell for tools", () => {
  test("a tool using the sh -c form is refused inside a research step", async () => {
    script = [reply({ tool_calls: [toolCall("c1", "A_SHELL_STRING", { q: "hi" })] }), reply({ content: "ok" })];
    await runPipeline(pipeline({ tools: ["A_SHELL_STRING"] }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(requests[1].messages.at(-1).content).toMatch(/tool error: shell: the string form \(sh -c\) is refused/);
  });

  test("the argv form passes shell syntax through as a literal argument", async () => {
    const payload = "$(echo pwned); echo also";
    script = [reply({ tool_calls: [toolCall("c1", "A_SHELL_ARGV", { q: payload })] }), reply({ content: "ok" })];
    await runPipeline(pipeline({ tools: ["A_SHELL_ARGV"] }), {}, { actionDirs: [ACTIONS], models: { m: model() } });
    expect(requests[1].messages.at(-1).content).toBe(payload);
  });

  test("the host policy guards tool calls; a policy can deny the string form", async () => {
    const policy: Policy = {
      version: 1,
      default: "deny",
      rules: [
        { tool: "Bash", match: { form: "^string$" }, decision: "deny" },
        { tool: "Bash", match: { program: "^echo$" }, decision: "allow" },
      ],
    };
    script = [reply({ tool_calls: [toolCall("c1", "A_SHELL_ARGV", { q: "fine" })] }), reply({ content: "ok" })];
    const denied: string[] = [];
    await runPipeline(pipeline({ tools: ["A_SHELL_ARGV"] }), {}, {
      actionDirs: [ACTIONS],
      models: { m: model() },
      policy,
      onGateDecision: (e) => denied.push(e.decision.reason),
    });
    expect(requests[1].messages.at(-1).content).toBe("fine");
    expect(denied).toEqual([]);
  });
});

describe("research step — trace", () => {
  test("every tool call lands in a 0600 JSONL file under the host's trace dir", async () => {
    script = [reply({ tool_calls: [toolCall("c1", "A_LOOKUP", { query: "budget" })] }), reply({ content: "The prep." })];
    const events: ResearchEvent[] = [];
    await runPipeline(pipeline({ bind: { account: "alpha" } }), {}, {
      actionDirs: [ACTIONS],
      models: { m: model() },
      traceDir: TRACES,
      onResearchEvent: (e) => events.push(e),
    });
    const files = readdirSync(TRACES);
    expect(files.length).toBe(1);
    const path = join(TRACES, files[0]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(TRACES).mode & 0o777).toBe(0o700);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["start", "model", "tool", "model", "end"]);
    const tool = lines.find((l) => l.type === "tool");
    expect(tool.args).toBe(JSON.stringify({ query: "budget" }));
    expect(tool.input).toEqual({ query: "budget", account: "alpha" });
    expect(tool.result).toBe("found budget in alpha limit 5");
    const completed = events.find((e) => e.type === "research.completed") as any;
    expect(completed.stats.trace).toBe(path);
  });

  test("without a trace dir nothing is written", async () => {
    script = [reply({ tool_calls: [toolCall("c1", "A_LOOKUP", { query: "b" })] }), reply({ content: "ok" })];
    const before = readdirSync(process.cwd());
    const events: ResearchEvent[] = [];
    await runPipeline(pipeline({ bind: { account: "alpha" } }), {}, { actionDirs: [ACTIONS], models: { m: model() }, onResearchEvent: (e) => events.push(e) });
    expect(readdirSync(process.cwd())).toEqual(before);
    expect(existsSync(TRACES)).toBe(false);
    expect((events.at(-1) as any).stats.trace).toBeUndefined();
  });
});

describe("research step — model unavailable", () => {
  test("an unreachable model fails with ResearchUnavailable and keeps earlier output", async () => {
    const down = new OpenAICompatibleChatModel({ baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKeyEnv: KEY_ENV, env: { [KEY_ENV]: KEY } });
    const events: ResearchEvent[] = [];
    const result = await runPipeline(pipeline({}), {}, { actionDirs: [ACTIONS], models: { m: down }, onResearchEvent: (e) => events.push(e) });
    expect(result.success).toBe(false);
    expect(result.cause).toBeInstanceOf(ResearchUnavailable);
    expect(result.output!.topic).toBe("the quarterly review");
    expect(existsSync(MARKER)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "research.failed", unavailable: true });
  });

  test("a model missing from options fails as a plain step failure", async () => {
    const result = await runPipeline(pipeline({ model: "nope" }), {}, { actionDirs: [ACTIONS], models: {} });
    expect(result.error).toMatch(/no model 'nope'/);
    expect(result.cause).not.toBeInstanceOf(ResearchUnavailable);
  });

  test("inside map, the original error survives on MapItemFailure", async () => {
    const down = new OpenAICompatibleChatModel({ baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKeyEnv: KEY_ENV, env: { [KEY_ENV]: KEY } });
    const p = {
      name: "P",
      actions: [{ map: { over: "items", as: "item", collect: "out", actions: [{ research: { name: "r", model: "m", prompt: "p", tools: ["A_OTHER"] } }] } }],
    } as any;
    const result = await runPipeline(p, { items: [1] }, { actionDirs: [ACTIONS], models: { m: down } });
    expect((result.cause as any).original).toBeInstanceOf(ResearchUnavailable);
  });
});

describe("research step — degrade per item inside map", () => {
  test("onError: collect keeps every item's deterministic work and flags the unavailable ones", async () => {
    const down = new OpenAICompatibleChatModel({ baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKeyEnv: KEY_ENV, env: { [KEY_ENV]: KEY } });
    createAction("A_MARK", { input: { item: { type: "number" } }, output: {} }, `export default {
      async execute(input) {
        await Bun.write(${JSON.stringify(DIR)} + "/mark-" + input.item, "done");
        return input;
      }
    };`);
    const p = {
      name: "P",
      actions: [{ map: { over: "items", as: "item", collect: "out", onError: "collect", actions: ["A_MARK", { research: { name: "r", model: "m", prompt: "p", tools: ["A_OTHER"] } }] } }],
    } as any;
    const result = await runPipeline(p, { items: [1, 2] }, { actionDirs: [ACTIONS], models: { m: down } });
    expect(result.success).toBe(true);
    expect(existsSync(join(DIR, "mark-1"))).toBe(true);
    expect(existsSync(join(DIR, "mark-2"))).toBe(true);
    const out = result.output!.out as any[];
    expect(out.map((e) => [e._error, e.unavailable, e.index])).toEqual([[true, true, 0], [true, true, 1]]);
  });

  test("a failure that is not unavailability carries no flag", async () => {
    const p = {
      name: "P",
      actions: [{ map: { over: "items", as: "item", collect: "out", onError: "collect", actions: [{ research: { name: "r", model: "missing", prompt: "p", tools: ["A_OTHER"] } }] } }],
    } as any;
    const result = await runPipeline(p, { items: [1] }, { actionDirs: [ACTIONS], models: {} });
    expect((result.output!.out as any[])[0].unavailable).toBeUndefined();
  });
});

describe("OpenAICompatibleChatModel", () => {
  test("a missing key is unavailable, named by variable, with no fallback", async () => {
    const m = new OpenAICompatibleChatModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "x", apiKeyEnv: "PULSE_TEST_UNSET_KEY", env: { OPENAI_API_KEY: "other" } });
    const err = await m.complete({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.message).toMatch(/no key in PULSE_TEST_UNSET_KEY/);
    expect(requests.length).toBe(0);
  });

  test("503 and 429 are unavailable; 400 is a model error; the key never appears", async () => {
    script = [
      { status: 503, raw: `upstream down for key ${KEY}` },
      { status: 429, raw: "slow down" },
      { status: 400, raw: `bad request, key=${KEY}` },
    ];
    const m = model();
    const e1 = await m.complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    const e2 = await m.complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    const e3 = await m.complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(e1).toBeInstanceOf(ModelUnavailableError);
    expect(e2).toBeInstanceOf(ModelUnavailableError);
    expect(e3).not.toBeInstanceOf(ModelUnavailableError);
    expect(e3.name).toBe("ModelError");
    for (const e of [e1, e2, e3]) expect(e.message).not.toContain(KEY);
    expect(e1.message).toContain("[redacted]");
  });

  test("a timeout is unavailable", async () => {
    const slow = Bun.serve({ port: 0, fetch: () => new Promise<Response>((r) => setTimeout(() => r(Response.json({})), 500)) });
    const m = new OpenAICompatibleChatModel({ baseUrl: `http://127.0.0.1:${slow.port}/v1`, model: "x", apiKeyEnv: KEY_ENV, env: { [KEY_ENV]: KEY }, timeoutMs: 50 });
    const err = await m.complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    slow.stop(true);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.reason).toBe("timeout");
  });

  test("parses tool calls, usage and reasoning; sends no tools field when none are given", async () => {
    script = [{ body: { choices: [{ message: { content: null, reasoning_content: "thinking", tool_calls: [toolCall("a", "T", { x: 1 })] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } } }];
    const res = await model({ maxTokens: 99, temperature: 0.2 }).complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.toolCalls).toEqual([toolCall("a", "T", { x: 1 }) as any]);
    expect(res.usage).toEqual({ input: 3, output: 4 });
    expect(res.reasoning).toBe("thinking");
    expect("tools" in requests[0]).toBe(false);
    expect(requests[0].max_tokens).toBe(99);
    expect(requests[0].temperature).toBe(0.2);
    expect(requests[0].stream).toBe(false);
  });

  test("constructor refuses a config without apiKeyEnv", () => {
    expect(() => new OpenAICompatibleChatModel({ baseUrl: "http://x/v1", model: "m", apiKeyEnv: "" })).toThrow(/apiKeyEnv/);
  });
});
