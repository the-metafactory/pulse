/**
 * P-801 — SOC demo block palette: fetch-family enrichment blocks.
 * Stub + (mocked) real paths per block, mirroring tests/soc-demo-blocks.test.ts.
 *
 * Contract under test (the stub-safe scaffold, reference: A_FETCH_VIRUSTOTAL):
 *   - env unset  → prints intent, returns canned fixture (source "stub"), no network call
 *   - env set    → calls the injected fetch capability, parses the real shape
 *   - passthrough: unrelated payload fields survive
 *   - HIBP / GreyNoise: 404 is a negative result (not breached / not seen), not an error
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ctxWith, setEnv, restoreEnv } from "./helpers/soc-demo-test-helpers";

afterEach(restoreEnv);

// ---------------------------------------------------------------------------
// A_FETCH_HIBP
// ---------------------------------------------------------------------------

describe("A_FETCH_HIBP", () => {
  test("stub path: HIBP_API_KEY unset returns canned 2-breach hit, no fetch", async () => {
    setEnv("HIBP_API_KEY", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_HIBP/action");
    const result = (await mod.default.execute(
      { email: "test@example.org", scenario: "x" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;

    const hibp = result.hibp as Record<string, unknown>;
    expect(hibp.source).toBe("stub");
    expect(hibp.breached).toBe(true);
    expect((hibp.breaches as unknown[]).length).toBe(2);
    expect(fetchCalled).toBe(false);
    expect(result.scenario).toBe("x"); // passthrough
  });

  test("real path (mocked): parses breach array and sets breached true", async () => {
    setEnv("HIBP_API_KEY", "test-key");
    let requestedUrl = "";
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_HIBP/action");
    const result = (await mod.default.execute(
      { email: "victim@example.org" },
      ctxWith(async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify([{ Name: "RealLeak", Domain: "real.example", BreachDate: "2023-09-01" }]),
        );
      }),
    )) as Record<string, unknown>;

    const hibp = result.hibp as Record<string, unknown>;
    expect(hibp.source).toBe("hibp");
    expect(hibp.breached).toBe(true);
    expect(requestedUrl).toContain("/api/v3/breachedaccount/");
    const breaches = hibp.breaches as Array<Record<string, unknown>>;
    expect(breaches.length).toBe(1);
    expect(breaches[0]?.name).toBe("RealLeak");
  });

  test("real path: 404 is not-breached, not an error", async () => {
    setEnv("HIBP_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_HIBP/action");
    const result = (await mod.default.execute(
      { email: "clean@example.org" },
      ctxWith(async () => new Response("", { status: 404 })),
    )) as Record<string, unknown>;

    const hibp = result.hibp as Record<string, unknown>;
    expect(hibp.source).toBe("hibp");
    expect(hibp.breached).toBe(false);
    expect((hibp.breaches as unknown[]).length).toBe(0);
  });

  test("real path: other non-OK response throws", async () => {
    setEnv("HIBP_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_HIBP/action");
    await expect(
      mod.default.execute({ email: "x@example.org" }, ctxWith(async () => new Response("nope", { status: 429 }))),
    ).rejects.toThrow("429");
  });
});

// ---------------------------------------------------------------------------
// A_FETCH_URLSCAN
// ---------------------------------------------------------------------------

describe("A_FETCH_URLSCAN", () => {
  test("stub path: URLSCAN_API_KEY unset returns canned malicious verdict, no fetch", async () => {
    setEnv("URLSCAN_API_KEY", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_URLSCAN/action");
    const result = (await mod.default.execute(
      { url: "evil.example", scenario: "y" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;

    const urlscan = result.urlscan as Record<string, unknown>;
    expect(urlscan.source).toBe("stub");
    expect(urlscan.verdict).toBe("malicious");
    expect(urlscan.score).toBe(85);
    expect(urlscan.screenshot_url).toBe("https://urlscan.io/screenshots/stub.png");
    expect(fetchCalled).toBe(false);
    expect(result.scenario).toBe("y"); // passthrough
  });

  test("real path (mocked): submits scan and derives report URLs from uuid", async () => {
    setEnv("URLSCAN_API_KEY", "test-key");
    let requestedUrl = "";
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_URLSCAN/action");
    const result = (await mod.default.execute(
      { url: "https://evil.example/x" },
      ctxWith(async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ uuid: "abc-123" }));
      }),
    )) as Record<string, unknown>;

    const urlscan = result.urlscan as Record<string, unknown>;
    expect(urlscan.source).toBe("urlscan");
    expect(urlscan.verdict).toBe("submitted");
    expect(urlscan.score).toBe(0);
    expect(requestedUrl).toContain("/api/v1/scan/");
    expect(urlscan.report_url).toBe("https://urlscan.io/result/abc-123/");
    expect(urlscan.screenshot_url).toBe("https://urlscan.io/screenshots/abc-123.png");
  });

  test("real path: non-OK response throws", async () => {
    setEnv("URLSCAN_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_URLSCAN/action");
    await expect(
      mod.default.execute({ url: "https://evil.example/x" }, ctxWith(async () => new Response("nope", { status: 400 }))),
    ).rejects.toThrow("400");
  });
});

// ---------------------------------------------------------------------------
// A_FETCH_GREYNOISE
// ---------------------------------------------------------------------------

describe("A_FETCH_GREYNOISE", () => {
  test("stub path: GREYNOISE_API_KEY unset returns canned Censys scanner, no fetch", async () => {
    setEnv("GREYNOISE_API_KEY", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_GREYNOISE/action");
    const result = (await mod.default.execute(
      { ip: "1.2.3.4", scenario: "z" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;

    const gn = result.greynoise as Record<string, unknown>;
    expect(gn.source).toBe("stub");
    expect(gn.noise).toBe(true);
    expect(gn.riot).toBe(false);
    expect(gn.classification).toBe("benign");
    expect(gn.name).toBe("Censys");
    expect(fetchCalled).toBe(false);
    expect(result.scenario).toBe("z"); // passthrough
  });

  test("real path (mocked): parses community response", async () => {
    setEnv("GREYNOISE_API_KEY", "test-key");
    let requestedUrl = "";
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_GREYNOISE/action");
    const result = (await mod.default.execute(
      { ip: "8.8.8.8" },
      ctxWith(async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({ noise: true, riot: true, classification: "malicious", name: "ScannerCo" }),
        );
      }),
    )) as Record<string, unknown>;

    const gn = result.greynoise as Record<string, unknown>;
    expect(gn.source).toBe("greynoise");
    expect(requestedUrl).toContain("/v3/community/");
    expect(gn.noise).toBe(true);
    expect(gn.riot).toBe(true);
    expect(gn.classification).toBe("malicious");
    expect(gn.name).toBe("ScannerCo");
  });

  test("real path: 404 is not-seen, not an error", async () => {
    setEnv("GREYNOISE_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_GREYNOISE/action");
    const result = (await mod.default.execute(
      { ip: "10.0.0.1" },
      ctxWith(async () => new Response("", { status: 404 })),
    )) as Record<string, unknown>;

    const gn = result.greynoise as Record<string, unknown>;
    expect(gn.source).toBe("greynoise");
    expect(gn.noise).toBe(false);
    expect(gn.classification).toBe("unknown");
    expect(gn.name).toBeNull();
  });

  test("real path: other non-OK response throws", async () => {
    setEnv("GREYNOISE_API_KEY", "test-key");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_GREYNOISE/action");
    await expect(
      mod.default.execute({ ip: "8.8.8.8" }, ctxWith(async () => new Response("nope", { status: 500 }))),
    ).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// A_FETCH_CRTSH (keyless — stub gate is CRTSH_LIVE, not an API key)
// ---------------------------------------------------------------------------

describe("A_FETCH_CRTSH", () => {
  test("stub path: CRTSH_LIVE unset returns canned 2-cert response, no fetch", async () => {
    setEnv("CRTSH_LIVE", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_CRTSH/action");
    const result = (await mod.default.execute(
      { domain: "example.org", scenario: "w" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("[]");
      }),
    )) as Record<string, unknown>;

    const crtsh = result.crtsh as Record<string, unknown>;
    expect(crtsh.source).toBe("stub");
    expect(crtsh.count).toBe(2);
    const certs = crtsh.certificates as Array<Record<string, unknown>>;
    expect(certs[0]?.common_name).toBe("example.org");
    expect(certs[1]?.common_name).toBe("login.example.org");
    expect(fetchCalled).toBe(false);
    expect(result.scenario).toBe("w"); // passthrough
  });

  test("real path (mocked): CRTSH_LIVE=1 maps crt.sh JSON and caps at 25", async () => {
    setEnv("CRTSH_LIVE", "1");
    let requestedUrl = "";
    const body = Array.from({ length: 30 }, (_, i) => ({
      issuer_name: "C=US, O=Let's Encrypt, CN=R3",
      common_name: `host${i}.example.org`,
      not_before: "2025-01-01T00:00:00",
      not_after: "2025-04-01T00:00:00",
    }));
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_CRTSH/action");
    const result = (await mod.default.execute(
      { domain: "example.org" },
      ctxWith(async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify(body));
      }),
    )) as Record<string, unknown>;

    const crtsh = result.crtsh as Record<string, unknown>;
    expect(crtsh.source).toBe("crtsh");
    expect(requestedUrl).toContain("crt.sh");
    expect(crtsh.count).toBe(25); // capped
    const certs = crtsh.certificates as Array<Record<string, unknown>>;
    expect(certs[0]?.issuer).toBe("C=US, O=Let's Encrypt, CN=R3");
    expect(certs[0]?.common_name).toBe("host0.example.org");
  });

  test("real path: non-OK response throws", async () => {
    setEnv("CRTSH_LIVE", "1");
    const mod = await import("../examples/soc-demo/blocks/A_FETCH_CRTSH/action");
    await expect(
      mod.default.execute({ domain: "example.org" }, ctxWith(async () => new Response("nope", { status: 502 }))),
    ).rejects.toThrow("502");
  });
});
