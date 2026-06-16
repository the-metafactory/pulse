/**
 * Apertus (Infomaniak AI) agent provider — a Swiss-sovereign frontier backend.
 * OpenAI-compatible chat-completions; cloud, so it must NEVER serve a
 * `local-only` task (the sovereign router keeps those on-box).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  makeApertusAgentProvider,
  makeApertusAgentProviderFromEnv,
  makeSovereignAgentProvider,
} from "../examples/soc-demo/run-demo";
import type { AgentProvider, AgentTaskResult } from "../src/types/agent";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.APERTUS_API_TOKEN;
  delete process.env.APERTUS_PRODUCT_ID;
  delete process.env.INFOMANIAK_API_TOKEN;
  delete process.env.INFOMANIAK_AI_PRODUCT_ID;
});

describe("makeApertusAgentProvider", () => {
  test("POSTs OpenAI chat-completions to the Infomaniak AI endpoint with Bearer auth", async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "  malicious  " } }] }));
    }) as unknown as typeof fetch;

    const p = makeApertusAgentProvider({ apiToken: "tok", productId: "PROD", model: "apertus" });
    const r = await p.dispatch({ capability: "soc.triage.ip", prompt: "triage 1.2.3.4", sovereignty: { model_class: "frontier" } }, {});

    expect(seen.url).toBe("https://api.infomaniak.com/1/ai/PROD/openai/chat/completions");
    expect(seen.auth).toBe("Bearer tok");
    expect(seen.body?.model).toBe("apertus");
    expect((seen.body?.messages as unknown[]).length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.output).toBe("malicious"); // trimmed
  });

  test("non-OK response → failed (never throws)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const p = makeApertusAgentProvider({ apiToken: "t", productId: "P" });
    const r = await p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {});
    expect(r.status).toBe("failed");
    expect(r.error).toContain("429");
  });

  test("fromEnv: null without config, provider with APERTUS_* (or INFOMANIAK_*) set", () => {
    expect(makeApertusAgentProviderFromEnv()).toBeNull();
    process.env.APERTUS_API_TOKEN = "t";
    process.env.APERTUS_PRODUCT_ID = "P";
    expect(makeApertusAgentProviderFromEnv()).not.toBeNull();
  });

  test("sovereign router: local-only NEVER reaches Apertus (cloud); frontier does", async () => {
    const hits: string[] = [];
    const tag = (name: string): AgentProvider => ({
      async dispatch(): Promise<AgentTaskResult> {
        hits.push(name);
        return { task_id: "t", status: "completed", output: name, duration_ms: 0 };
      },
    });
    const router = makeSovereignAgentProvider({ frontier: tag("apertus"), local: tag("ollama") });

    await router.dispatch({ capability: "c", prompt: "x", sovereignty: { model_class: "local-only" } }, {});
    await router.dispatch({ capability: "c", prompt: "x", sovereignty: { frontier_ok: false } }, {});
    await router.dispatch({ capability: "c", prompt: "x", sovereignty: { model_class: "frontier" } }, {});

    expect(hits).toEqual(["ollama", "ollama", "apertus"]); // confidential stays local
  });
});
