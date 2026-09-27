import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chatModelLLM, createLocalCapabilities, FALLBACK_LLM_LABEL } from "../src/lib/capabilities";
import { runAction } from "../src/lib/action-runner";
import { OpenAICompatibleChatModel, ModelError, type ChatModel, type ChatRequest } from "../src/lib/chat-model";
import type { Policy } from "../src/types/policy";

/**
 * The fallback chain's first stage is `claude -p`. A fake `claude` that
 * touches a marker proves whether the chain ran: every test that asserts
 * "the chain did not run" has a control that asserts it did.
 */
let root: string;
let actionsDir: string;
let marker: string;
let fakeClaude: string;
const prevBin = process.env.PULSE_CLAUDE_BIN;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pulse-llm-injection-"));
  marker = join(root, "claude-ran");
  fakeClaude = join(root, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\necho '{"type":"result","result":"from-fallback"}'\n`);
  chmodSync(fakeClaude, 0o755);
  process.env.PULSE_CLAUDE_BIN = fakeClaude;

  actionsDir = join(root, "actions");
  const dir = join(actionsDir, "A_ASK");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "action.json"),
    JSON.stringify({
      name: "A_ASK",
      version: "1.0.0",
      description: "Ask the llm capability",
      input: { question: { type: "string", required: true } },
      output: { answer: { type: "string" } },
      requires: ["llm"],
    }),
  );
  writeFileSync(
    join(dir, "action.ts"),
    `export default {
      async execute(input, ctx) {
        const res = await ctx.capabilities.llm(input.question, { system: "be brief", maxTokens: 64 });
        return { answer: res.text };
      }
    };`,
  );
});

afterAll(() => {
  if (prevBin === undefined) delete process.env.PULSE_CLAUDE_BIN;
  else process.env.PULSE_CLAUDE_BIN = prevBin;
  rmSync(root, { recursive: true, force: true });
});

function resetMarker() {
  rmSync(marker, { force: true });
}

/** A ChatModel that records its requests and answers with `content`. */
function fakeModel(label: string, content: string | null = "from-model"): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    label,
    requests,
    async complete(request) {
      requests.push(request);
      return { content, toolCalls: [], finishReason: "stop", usage: { input: 3, output: 2 } };
    },
  };
}

describe("llm backed by an injected ChatModel", () => {
  test("control: without a model, the fallback chain runs", async () => {
    resetMarker();
    const result = await runAction("A_ASK", { question: "hi" }, { actionDirs: [actionsDir] });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ answer: "from-fallback" });
    expect(existsSync(marker)).toBe(true);
  });

  test("runAction calls the injected model and never the fallback chain", async () => {
    resetMarker();
    const model = fakeModel("spark-longctx");
    const result = await runAction("A_ASK", { question: "hi" }, { actionDirs: [actionsDir], llmModel: model });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ answer: "from-model" });
    expect(model.requests).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  test("createLocalCapabilities sends the prompt to an OpenAI-compatible endpoint", async () => {
    resetMarker();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"ok":true}\n```' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const model = new OpenAICompatibleChatModel({
      baseUrl: "https://gateway.example/v1/",
      model: "longctx",
      apiKeyEnv: "TEST_SPARK_KEY",
      env: { TEST_SPARK_KEY: "sk-test" },
      fetch,
    });

    const caps = await createLocalCapabilities(["llm"], { llmModel: model });
    const res = await caps.llm!("the prompt", { system: "the system", json: true, maxTokens: 200, tier: "smart" });

    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({ input: 11, output: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway.example/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("longctx");
    expect(body.messages).toEqual([
      { role: "system", content: "the system" },
      { role: "user", content: "the prompt" },
    ]);
    expect(body.max_tokens).toBe(200);
    expect("tools" in body).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("an answer without text is an error, not an empty response", async () => {
    const llm = chatModelLLM(fakeModel("spark-longctx", null));
    await expect(llm("hi")).rejects.toBeInstanceOf(ModelError);
    const blank = chatModelLLM(fakeModel("spark-longctx", "   "));
    await expect(blank("hi")).rejects.toBeInstanceOf(ModelError);
  });
});

describe("llm under an enforcement policy", () => {
  const onlySpark: Policy = {
    version: 1,
    default: "deny",
    rules: [{ tool: "LLM", match: { model: "^spark-longctx$" }, decision: "allow" }],
  };

  test("a default-deny policy blocks llm", async () => {
    resetMarker();
    const model = fakeModel("spark-longctx");
    const result = await runAction("A_ASK", { question: "hi" }, {
      actionDirs: [actionsDir],
      llmModel: model,
      policy: { version: 1, default: "deny", rules: [] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("enforcement gate denied LLM");
    expect(model.requests).toHaveLength(0);
  });

  test("a policy pinned to the injected model allows it", async () => {
    const model = fakeModel("spark-longctx");
    const result = await runAction("A_ASK", { question: "hi" }, {
      actionDirs: [actionsDir],
      llmModel: model,
      policy: onlySpark,
    });
    expect(result.success).toBe(true);
    expect(model.requests).toHaveLength(1);
  });

  test("the same policy denies the fallback chain before it runs, and the audit sees no prompt", async () => {
    resetMarker();
    const audit: { tool: string; input: Record<string, unknown> }[] = [];
    const result = await runAction("A_ASK", { question: "secret customer text" }, {
      actionDirs: [actionsDir],
      policy: onlySpark,
      onGateDecision: (e) => audit.push({ tool: e.tool, input: e.input }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("enforcement gate denied LLM");
    expect(existsSync(marker)).toBe(false);
    expect(audit).toEqual([{ tool: "LLM", input: { model: FALLBACK_LLM_LABEL } }]);
  });
});
