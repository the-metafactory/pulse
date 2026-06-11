/**
 * P-801 — SOC demo block palette: stub + (mocked) real paths per block.
 * ISC-11..24 of the SOC demo plan (ISA.md, slug 2026-06-11-pulse-soc-demo-composer).
 *
 * Contract under test (the stub-safe scaffold, reference: A_FETCH_VIRUSTOTAL):
 *   - env unset  → prints intent, returns canned fixture, no network call
 *   - env set    → calls the injected fetch capability, parses the real shape
 *   - passthrough: unrelated payload fields survive
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ActionContext } from "../src/types/action";

function ctxWith(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): ActionContext {
  return {
    capabilities: { fetch: fetchImpl as typeof globalThis.fetch },
    env: {},
    meta: { actionName: "test", startedAt: new Date().toISOString(), mode: "local" },
  } as unknown as ActionContext;
}

const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  if (!(key in SAVED_ENV)) SAVED_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(SAVED_ENV)) delete SAVED_ENV[key];
});

// ---------------------------------------------------------------------------
// A_FETCH_VIRUSTOTAL (ISC-11) — the reference scaffold
// ---------------------------------------------------------------------------

describe("A_FETCH_VIRUSTOTAL", () => {
  test("stub path: VT_API_KEY unset returns canned 3/70 verdict, no fetch", async () => {
    setEnv("VT_API_KEY", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_VIRUSTOTAL/action");
    const result = (await mod.default.execute(
      { ioc: "evil.example", scenario: "x" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;

    const verdict = result.vt_verdict as Record<string, unknown>;
    expect(verdict.source).toBe("stub");
    expect(verdict.malicious).toBe(3);
    expect(verdict.total_vendors).toBe(70);
    expect(fetchCalled).toBe(false);
    expect(result.scenario).toBe("x"); // passthrough
  });

  test("real path (mocked): parses last_analysis_stats and classifies", async () => {
    setEnv("VT_API_KEY", "test-key");
    let requestedUrl = "";
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_VIRUSTOTAL/action");
    const result = (await mod.default.execute(
      { ioc: "44d88612fea8a8f36de82e1278abb02f44d88612fea8a8f36de82e1278abb02f" },
      ctxWith(async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({
            data: { attributes: { last_analysis_stats: { malicious: 5, harmless: 60, undetected: 5 } } },
          }),
        );
      }),
    )) as Record<string, unknown>;

    const verdict = result.vt_verdict as Record<string, unknown>;
    expect(verdict.source).toBe("virustotal");
    expect(verdict.ioc_type).toBe("hash");
    expect(requestedUrl).toContain("/api/v3/files/");
    expect(verdict.malicious).toBe(5);
    expect(verdict.total_vendors).toBe(70);
    expect(verdict.verdict).toBe("malicious");
  });

  test("real path: non-OK response throws (visible failure, not silent pass)", async () => {
    setEnv("VT_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_VIRUSTOTAL/action");
    await expect(
      mod.default.execute({ ioc: "https://evil.example/x" }, ctxWith(async () => new Response("nope", { status: 429 }))),
    ).rejects.toThrow("429");
  });
});
