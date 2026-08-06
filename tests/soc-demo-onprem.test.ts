/**
 * On-prem agent provider — an operator-run OpenAI-compatible inference cluster
 * serving the LOCAL sovereignty lane. Unlike Apertus (Swiss *cloud*, frontier
 * lane), this is hardware the principal controls, so it is allowed to take
 * `local-only` tasks. These tests pin that routing, the wire shape, and the
 * fail-closed behaviour.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  describeAgentRouting,
  makeOnPremAgentProvider,
  makeOnPremAgentProviderFromEnv,
  makeSovereignAgentProvider,
  resolveAgentProvider,
} from "../examples/soc-demo/run-demo";
import type { AgentProvider, AgentTaskResult } from "../src/types/agent";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PULSE_ONPREM_URL;
  delete process.env.PULSE_ONPREM_KEY;
  delete process.env.PULSE_ONPREM_MODEL;
  delete process.env.PULSE_ONPREM_TIMEOUT_MS;
  delete process.env.PULSE_LOCAL_MODEL;
  delete process.env.OLLAMA_URL;
  delete process.env.APERTUS_API_TOKEN;
  delete process.env.APERTUS_PRODUCT_ID;
});

describe("makeOnPremAgentProvider", () => {
  test("POSTs OpenAI chat-completions to {baseUrl}/chat/completions with Bearer auth", async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        auth: (init.headers as Record<string, string>).Authorization,
        body: JSON.parse(init.body as string),
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: "  benign  " } }] }));
    }) as unknown as typeof fetch;

    const p = makeOnPremAgentProvider({
      baseUrl: "https://cluster.example/v1",
      apiKey: "k",
      model: "coder",
    });
    const r = await p.dispatch(
      { capability: "soc.triage.ip", prompt: "triage 1.2.3.4", sovereignty: { model_class: "local-only" } },
      {},
    );

    expect(seen.url).toBe("https://cluster.example/v1/chat/completions");
    expect(seen.auth).toBe("Bearer k");
    expect(seen.body?.model).toBe("coder");
    expect(seen.body?.stream).toBe(false);
    expect((seen.body?.messages as unknown[]).length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.output).toBe("benign"); // trimmed
  });

  test("a trailing slash on baseUrl does not double up the path", () => {
    let seen = "";
    globalThis.fetch = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    }) as unknown as typeof fetch;
    const p = makeOnPremAgentProvider({ baseUrl: "https://cluster.example/v1/", apiKey: "k" });
    return p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {}).then(() => {
      expect(seen).toBe("https://cluster.example/v1/chat/completions");
    });
  });

  test("non-OK response → failed, never throws (429 quota case included)", async () => {
    globalThis.fetch = (async () =>
      new Response("Rate limit exceeded", { status: 429 })) as unknown as typeof fetch;
    const p = makeOnPremAgentProvider({ baseUrl: "https://cluster.example/v1", apiKey: "k" });
    const r = await p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {});
    expect(r.status).toBe("failed");
    expect(r.error).toContain("429");
  });

  test("a malformed body → failed, not a crash", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }))) as unknown as typeof fetch;
    const p = makeOnPremAgentProvider({ baseUrl: "https://cluster.example/v1", apiKey: "k" });
    const r = await p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {});
    expect(r.status).toBe("failed");
    expect(r.error).toContain("no choices[0].message.content");
  });

  test("an already-aborted signal makes NO network call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const p = makeOnPremAgentProvider({ baseUrl: "https://cluster.example/v1", apiKey: "k" });
    const r = await p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {
      signal: AbortSignal.abort(),
    });
    expect(called).toBe(false);
    expect(r.status).toBe("failed");
  });

  test("the key never appears in a failure message", async () => {
    globalThis.fetch = (async () => new Response("upstream said no", { status: 500 })) as unknown as typeof fetch;
    const p = makeOnPremAgentProvider({ baseUrl: "https://cluster.example/v1", apiKey: "sk-supersecret" });
    const r = await p.dispatch({ capability: "c", prompt: "x", sovereignty: {} }, {});
    expect(r.error).not.toContain("sk-supersecret");
  });
});

describe("makeOnPremAgentProviderFromEnv", () => {
  test("null unless BOTH url and key are set", () => {
    expect(makeOnPremAgentProviderFromEnv()).toBeNull();
    process.env.PULSE_ONPREM_URL = "https://cluster.example/v1";
    expect(makeOnPremAgentProviderFromEnv()).toBeNull();
    process.env.PULSE_ONPREM_KEY = "k";
    expect(makeOnPremAgentProviderFromEnv()).not.toBeNull();
  });
});

describe("sovereign routing with an on-prem lane", () => {
  const tag = (name: string, hits: string[]): AgentProvider => ({
    async dispatch(): Promise<AgentTaskResult> {
      hits.push(name);
      return { task_id: "t", status: "completed", output: name, duration_ms: 0 };
    },
  });

  test("local-only goes to the local lane, frontier to the frontier lane", async () => {
    const hits: string[] = [];
    const p = makeSovereignAgentProvider({
      frontier: tag("frontier", hits),
      local: tag("local", hits),
    });
    await p.dispatch({ capability: "c", prompt: "x", sovereignty: { model_class: "local-only" } }, {});
    await p.dispatch({ capability: "c", prompt: "x", sovereignty: { frontier_ok: false } }, {});
    await p.dispatch({ capability: "c", prompt: "x", sovereignty: { model_class: "frontier" } }, {});
    expect(hits).toEqual(["local", "local", "frontier"]);
  });

  test("on-prem WINS the local lane over Ollama when both are configured", async () => {
    let hitUrl = "";
    globalThis.fetch = (async (url: string) => {
      hitUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as unknown as typeof fetch;
    process.env.PULSE_ONPREM_URL = "https://cluster.example/v1";
    process.env.PULSE_ONPREM_KEY = "k";
    process.env.PULSE_LOCAL_MODEL = "gemma4:latest"; // Ollama also configured

    const p = resolveAgentProvider((async () => ({ text: "" })) as never);
    expect(p).toBeDefined();
    await p!.dispatch({ capability: "c", prompt: "x", sovereignty: { model_class: "local-only" } }, {});
    // The on-prem OpenAI path, NOT Ollama's /api/generate.
    expect(hitUrl).toBe("https://cluster.example/v1/chat/completions");
  });

  test("on-prem alone (no Ollama) is enough to enable sovereign routing", () => {
    expect(resolveAgentProvider((async () => ({ text: "" })) as never)).toBeUndefined();
    process.env.PULSE_ONPREM_URL = "https://cluster.example/v1";
    process.env.PULSE_ONPREM_KEY = "k";
    expect(resolveAgentProvider((async () => ({ text: "" })) as never)).toBeDefined();
  });
});

describe("describeAgentRouting", () => {
  test("reports the winning backend per lane, and leaks no host or key", () => {
    process.env.PULSE_ONPREM_URL = "https://secret-host.internal/v1";
    process.env.PULSE_ONPREM_KEY = "sk-supersecret";
    process.env.PULSE_ONPREM_MODEL = "coder";
    const line = describeAgentRouting();
    expect(line).toContain("on-prem cluster (coder)");
    expect(line).toContain("frontier → composer LLM");
    expect(line).not.toContain("secret-host.internal");
    expect(line).not.toContain("sk-supersecret");
  });

  test("falls back to Ollama, then to fail-closed", () => {
    expect(describeAgentRouting()).toContain("refused (fail-closed)");
    process.env.PULSE_LOCAL_MODEL = "gemma4:latest";
    expect(describeAgentRouting()).toContain("Ollama (gemma4:latest)");
  });
});
