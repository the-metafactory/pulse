/**
 * P-801 — SOC demo block palette: stub + (mocked) real paths per block.
 * ISC-11..23 of the SOC demo plan (ISC-24 catalog coverage lands with the integration wiring) (ISA.md, slug 2026-06-11-pulse-soc-demo-composer).
 *
 * Contract under test (the stub-safe scaffold, reference: A_FETCH_VIRUSTOTAL):
 *   - env unset  → prints intent, returns canned fixture, no network call
 *   - env set    → calls the injected fetch capability, parses the real shape
 *   - passthrough: unrelated payload fields survive
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ctxWith, setEnv, restoreEnv } from "./helpers/soc-demo-test-helpers";

afterEach(restoreEnv);

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

// ---------------------------------------------------------------------------
// A_NOTIFY_MATTERMOST — token/URL pairing rule (sage PR #40 blocker)
// ---------------------------------------------------------------------------

describe("A_NOTIFY_MATTERMOST token pairing", () => {
  test("input mattermost_url without input token never sends the env token", async () => {
    setEnv("MATTERMOST_URL", "https://trusted.example");
    setEnv("MATTERMOST_CHANNEL_ID", "chan");
    setEnv("MATTERMOST_BOT_TOKEN", "env-secret");
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_NOTIFY_MATTERMOST/action");
    const result = (await mod.default.execute(
      { advisory_doc: { markdown: "x" }, mattermost_url: "https://attacker.example" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;
    // Env token must not travel to the input-supplied URL: block skips.
    expect(fetchCalled).toBe(false);
    expect((result.mattermost as { skipped?: boolean }).skipped).toBe(true);
  });

  test("input URL with input token is allowed (caller supplied both)", async () => {
    setEnv("MATTERMOST_URL", undefined);
    setEnv("MATTERMOST_CHANNEL_ID", undefined);
    setEnv("MATTERMOST_BOT_TOKEN", undefined);
    const auth: string[] = [];
    const mod = await import("../examples/soc-demo/blocks/A_NOTIFY_MATTERMOST/action");
    await mod.default.execute(
      {
        advisory_doc: { markdown: "hello" },
        mattermost_url: "https://self-hosted.example",
        mattermost_channel_id: "chan",
        mattermost_bot_token: "input-token",
      },
      ctxWith(async (_url, init) => {
        auth.push(String((init?.headers as Record<string, string>)?.Authorization));
        return new Response(JSON.stringify({ id: "post1" }));
      }),
    );
    expect(auth[0]).toBe("Bearer input-token");
  });
});

// ---------------------------------------------------------------------------
// A_SANITIZE_IOCS / A_FORMAT_ADVISORY — collect-value contract (P-600 migration)
// These consume an AGENT step's collect field, which stores the result VALUE
// (object or model JSON string), NOT the transport envelope.
// ---------------------------------------------------------------------------

describe("A_SANITIZE_IOCS — reads the collected value, not an envelope", () => {
  const load = () => import("../examples/soc-demo/blocks/A_SANITIZE_IOCS/action");

  test("triage as a VALUE OBJECT: drops internal hosts, keeps external", async () => {
    const mod = await load();
    const triage = {
      verdict: "phishing",
      confidence: 0.9,
      iocs: {
        urls: ["https://evil.example/login", "https://mail.switch.ch/x"],
        domains: ["evil.example", "example-university.ch"],
        senders: ["a@evil.example", "b@mail.switch.ch"],
        hashes: ["abc"],
      },
    };
    const r = (await mod.default.execute({ triage, scenario: "s" }, ctxWith())) as Record<string, unknown>;
    const out = r.iocs_sanitized as Record<string, string[] | string | number>;
    expect(out.verdict).toBe("phishing");
    expect(out.urls).toEqual(["https://evil.example/login"]); // *.switch.ch dropped
    expect(out.domains).toEqual(["evil.example"]); // example-university.ch dropped
    expect(out.senders).toEqual(["a@evil.example"]); // @*.switch.ch dropped
    expect(out.hashes).toEqual(["abc"]);
    expect(r.scenario).toBe("s"); // passthrough
  });

  test("triage as a JSON STRING: parsed, not treated as an envelope", async () => {
    const mod = await load();
    const triage = JSON.stringify({ verdict: "benign", iocs: { domains: ["evil.example"] } });
    const r = (await mod.default.execute({ triage }, ctxWith())) as Record<string, unknown>;
    const out = r.iocs_sanitized as Record<string, unknown>;
    expect(out.verdict).toBe("benign");
    expect(out.domains).toEqual(["evil.example"]);
  });

  test("missing/garbled triage degrades to empty, does not crash", async () => {
    const mod = await load();
    for (const triage of [undefined, "not json", 42, null]) {
      const r = (await mod.default.execute({ triage }, ctxWith())) as Record<string, unknown>;
      const out = r.iocs_sanitized as Record<string, unknown>;
      expect(out.urls).toEqual([]);
      expect(out.domains).toEqual([]);
    }
  });
});

describe("A_FORMAT_ADVISORY — reads the collected enrichment value", () => {
  test("enrichment as a VALUE OBJECT lands in the advisory (not silently empty)", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_FORMAT_ADVISORY/action");
    const r = (await mod.default.execute(
      {
        triage: { verdict: "phishing" },
        enrichment: { advisory: "Confirmed phishing campaign targeting members." },
        iocs_sanitized: { urls: ["https://evil.example"] },
        approval: { name: "approve", verdict: "pass", notes: "ok", opened_at: "", closed_at: "" },
        scenario: "s",
      },
      ctxWith(),
    )) as Record<string, unknown>;
    const doc = r.advisory_doc as { markdown?: string };
    expect(typeof doc.markdown).toBe("string");
    expect(doc.markdown).toContain("Confirmed phishing campaign");
  });
});

// ---------------------------------------------------------------------------
// A_INGEST_ATTACHMENT — fold chat file uploads into `text`
// ---------------------------------------------------------------------------

describe("A_INGEST_ATTACHMENT", () => {
  const load = () => import("../examples/soc-demo/blocks/A_INGEST_ATTACHMENT/action");

  test("fetches a text-like (.eml) attachment and folds it into text", async () => {
    const mod = await load();
    let fetched = "";
    const ctx = ctxWith(async (url) => {
      fetched = url;
      return new Response("From: evil@bad.example\nSubject: invoice\nClick hxxp://evil[.]example/x");
    });
    const r = (await mod.default.execute(
      {
        text: "please triage this mail",
        attachments: [{ name: "phish.eml", contentType: "message/rfc822", url: "https://cdn.example/phish.eml" }],
        scenario: "s",
      },
      ctx,
    )) as Record<string, any>;
    expect(fetched).toBe("https://cdn.example/phish.eml");
    expect(r.text).toContain("please triage this mail"); // pasted text preserved
    expect(r.text).toContain("evil@bad.example"); // attachment body folded in
    expect(r.text).toContain("hxxp://evil[.]example/x"); // IOCs now reach A_EXTRACT_IOCS
    expect(r.attachments_ingested.decoded).toBe(1);
    expect(r.scenario).toBe("s"); // passthrough
  });

  test("no attachments → passes text through unchanged", async () => {
    const mod = await load();
    let called = false;
    const ctx = ctxWith(async () => { called = true; return new Response("x"); });
    const r = (await mod.default.execute({ text: "just text" }, ctx)) as Record<string, any>;
    expect(r.text).toBe("just text");
    expect(called).toBe(false);
    expect(r.attachments_ingested.decoded).toBe(0);
  });

  test("binary/image attachments are skipped, not decoded (no OCR)", async () => {
    const mod = await load();
    let called = false;
    const ctx = ctxWith(async () => { called = true; return new Response("PNGDATA"); });
    const r = (await mod.default.execute(
      { text: "look", attachments: [{ name: "shot.png", contentType: "image/png", url: "https://cdn/x.png" }] },
      ctx,
    )) as Record<string, any>;
    expect(called).toBe(false); // not fetched
    expect(r.text).toBe("look");
    expect(r.attachments_ingested.decoded).toBe(0);
    expect(r.attachments_ingested.skipped).toBe(1);
  });

  test("a fetch error is recorded, never thrown", async () => {
    const mod = await load();
    const ctx = ctxWith(async () => new Response("nope", { status: 404 }));
    const r = (await mod.default.execute(
      { text: "t", attachments: [{ name: "a.txt", contentType: "text/plain", url: "https://cdn/a.txt" }] },
      ctx,
    )) as Record<string, any>;
    expect(r.text).toBe("t"); // unchanged (decode failed)
    expect(r.attachments_ingested.errors[0]).toContain("404");
  });
});
