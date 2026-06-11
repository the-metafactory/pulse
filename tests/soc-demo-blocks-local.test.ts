/**
 * P-801 — SOC demo block palette: the OFFLINE (D-class) blocks + the two
 * stub-safe env-gated adapters (A_OPEN_TICKET, A_SHARE_MISP).
 *
 * Mirrors tests/soc-demo-blocks.test.ts (the A_FETCH_VIRUSTOTAL scaffold):
 *   - offline blocks: known-input + unknown-input + passthrough, no env, no fetch
 *   - env-gated adapters: stub path (env unset, no fetch, source "stub") +
 *     real path mocked (env set, mock fetch, assert URL + auth + parsed id) +
 *     non-OK throws.
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
// 1. A_LOOKUP_GEOIP_ASN — offline IP → country + ASN
// ---------------------------------------------------------------------------

describe("A_LOOKUP_GEOIP_ASN", () => {
  test("known IP: resolves SWITCH (AS559, CH)", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_GEOIP_ASN/action");
    const result = (await mod.default.execute({ ip: "130.59.1.1", case_id: "c1" }, ctxWith())) as Record<string, unknown>;
    const geoip = result.geoip as Record<string, unknown>;
    expect(geoip.known).toBe(true);
    expect(geoip.country).toBe("CH");
    expect(geoip.asn).toBe(559);
    expect(geoip.as_org).toBe("SWITCH");
    expect(result.case_id).toBe("c1"); // passthrough
  });

  test("unknown IP: returns known false, never throws", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_GEOIP_ASN/action");
    const result = (await mod.default.execute({ ip: "203.0.113.250" }, ctxWith())) as Record<string, unknown>;
    const geoip = result.geoip as Record<string, unknown>;
    expect(geoip.known).toBe(false);
    expect(geoip.country).toBe("??");
    expect(geoip.asn).toBe(0);
    expect(geoip.as_org).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 2. A_LOOKUP_CVE — offline CVE → CVSS + KEV
// ---------------------------------------------------------------------------

describe("A_LOOKUP_CVE", () => {
  test("known CVE (case-normalized): Log4Shell critical + KEV", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_CVE/action");
    const result = (await mod.default.execute({ cve: "cve-2021-44228", ref: "r1" }, ctxWith())) as Record<string, unknown>;
    const info = result.cve_info as Record<string, unknown>;
    expect(info.known).toBe(true);
    expect(info.cve).toBe("CVE-2021-44228");
    expect(info.cvss).toBe(10.0);
    expect(info.severity).toBe("CRITICAL");
    expect(info.kev).toBe(true);
    expect(result.ref).toBe("r1"); // passthrough
  });

  test("unknown CVE: known false, cvss 0, kev false", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_CVE/action");
    const result = (await mod.default.execute({ cve: "CVE-1999-0001" }, ctxWith())) as Record<string, unknown>;
    const info = result.cve_info as Record<string, unknown>;
    expect(info.known).toBe(false);
    expect(info.cvss).toBe(0);
    expect(info.kev).toBe(false);
    expect(info.severity).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------
// 3. A_LOOKUP_OWNER — offline IP → OU + contact
// ---------------------------------------------------------------------------

describe("A_LOOKUP_OWNER", () => {
  test("known IP: resolves OU + contact", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_OWNER/action");
    const result = (await mod.default.execute({ ip: "82.130.64.10", tag: "t1" }, ctxWith())) as Record<string, unknown>;
    const owner = result.owner as Record<string, unknown>;
    expect(owner.known).toBe(true);
    expect(owner.ou).toBe("ETH Zürich — Informatikdienste");
    expect(owner.contact).toBe("noc@ethz.example.ch");
    expect(result.tag).toBe("t1"); // passthrough
  });

  test("unknown IP: known false, ou unknown, contact null", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_LOOKUP_OWNER/action");
    const result = (await mod.default.execute({ ip: "198.51.100.7" }, ctxWith())) as Record<string, unknown>;
    const owner = result.owner as Record<string, unknown>;
    expect(owner.known).toBe(false);
    expect(owner.ou).toBe("unknown");
    expect(owner.contact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. A_EXTRACT_IOCS — defang-aware deterministic extraction
// ---------------------------------------------------------------------------

describe("A_EXTRACT_IOCS", () => {
  test("defanged text: refangs, validates IPs, dedupes, includes URL host in domains", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_EXTRACT_IOCS/action");
    const text = [
      "Malware beacons to hxxps://evil[.]example[.]com/payload and again to hxxps://evil[.]example[.]com/payload.", // dup URL
      "C2 domain bad[.]actor[.]net resolves to 192[.]168[.]10[.]5 (valid).",
      "Bogus IP 999.1.2.3 should be rejected.",
      "Dropper sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.",
    ].join(" ");
    const result = (await mod.default.execute({ text, src: "s1" }, ctxWith())) as Record<string, unknown>;
    const iocs = result.iocs as { urls: string[]; domains: string[]; ips: string[]; hashes: string[] };

    expect(iocs.urls).toEqual(["https://evil.example.com/payload"]); // refanged + deduped
    expect(iocs.domains).toContain("evil.example.com"); // host of extracted URL
    expect(iocs.domains).toContain("bad.actor.net"); // free-standing defanged domain
    expect(iocs.ips).toContain("192.168.10.5"); // refanged + valid
    expect(iocs.ips).not.toContain("999.1.2.3"); // invalid octet rejected
    expect(iocs.hashes).toEqual(["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]);
    expect(result.src).toBe("s1"); // passthrough
  });

  test("empty text: all categories empty, never throws", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_EXTRACT_IOCS/action");
    const result = (await mod.default.execute({ text: "" }, ctxWith())) as Record<string, unknown>;
    const iocs = result.iocs as { urls: string[]; domains: string[]; ips: string[]; hashes: string[] };
    expect(iocs.urls).toEqual([]);
    expect(iocs.domains).toEqual([]);
    expect(iocs.ips).toEqual([]);
    expect(iocs.hashes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. A_TAG_TLP — one case per marking
// ---------------------------------------------------------------------------

describe("A_TAG_TLP", () => {
  test("RED: active-incident language", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_TAG_TLP/action");
    const result = (await mod.default.execute({ text: "This is an active incident, do not share." }, ctxWith())) as Record<string, unknown>;
    expect((result.tlp as Record<string, unknown>).marking).toBe("TLP:RED");
  });

  test("AMBER: credentials / personal data", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_TAG_TLP/action");
    const result = (await mod.default.execute({ text: "Leaked password and PII for the victim account." }, ctxWith())) as Record<string, unknown>;
    expect((result.tlp as Record<string, unknown>).marking).toBe("TLP:AMBER");
  });

  test("GREEN: internal community language", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_TAG_TLP/action");
    const result = (await mod.default.execute({ text: "Share with member institutions in our constituency." }, ctxWith())) as Record<string, unknown>;
    expect((result.tlp as Record<string, unknown>).marking).toBe("TLP:GREEN");
  });

  test("CLEAR: no keywords, no default", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_TAG_TLP/action");
    const result = (await mod.default.execute({ text: "Routine maintenance announcement.", note: "n1" }, ctxWith())) as Record<string, unknown>;
    expect((result.tlp as Record<string, unknown>).marking).toBe("TLP:CLEAR");
    expect(result.note).toBe("n1"); // passthrough
  });

  test("default_tlp honored when no keywords match", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_TAG_TLP/action");
    const result = (await mod.default.execute({ text: "Routine note.", default_tlp: "TLP:GREEN" }, ctxWith())) as Record<string, unknown>;
    expect((result.tlp as Record<string, unknown>).marking).toBe("TLP:GREEN");
  });
});

// ---------------------------------------------------------------------------
// 6. A_OPEN_TICKET — stub-safe env-gated adapter
// ---------------------------------------------------------------------------

describe("A_OPEN_TICKET", () => {
  test("stub path: env unset returns synthetic DEMO id, no fetch", async () => {
    setEnv("TICKET_API_URL", undefined);
    setEnv("TICKET_API_TOKEN", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_OPEN_TICKET/action");
    const result = (await mod.default.execute(
      { subject: "Phishing wave against members", body: "details", queue: "Abuse", corr: "x" },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;
    const ticket = result.ticket as Record<string, unknown>;
    expect(ticket.source).toBe("stub");
    expect(String(ticket.id)).toMatch(/^DEMO-/);
    expect(ticket.url).toBeNull();
    expect(ticket.queue).toBe("Abuse");
    expect(fetchCalled).toBe(false);
    expect(result.corr).toBe("x"); // passthrough
  });

  test("stub id is deterministic per subject", async () => {
    setEnv("TICKET_API_URL", undefined);
    setEnv("TICKET_API_TOKEN", undefined);
    const mod = await import("../examples/soc-demo/blocks/A_OPEN_TICKET/action");
    const a = (await mod.default.execute({ subject: "Same subject" }, ctxWith())) as Record<string, unknown>;
    const b = (await mod.default.execute({ subject: "Same subject" }, ctxWith())) as Record<string, unknown>;
    expect((a.ticket as Record<string, unknown>).id).toBe((b.ticket as Record<string, unknown>).id);
  });

  test("real path (mocked): POSTs to RT REST 2.0 with token auth, parses id", async () => {
    setEnv("TICKET_API_URL", "https://rt.example.ch");
    setEnv("TICKET_API_TOKEN", "secret-token");
    let requestedUrl = "";
    let authHeader = "";
    const mod = await import("../examples/soc-demo/blocks/A_OPEN_TICKET/action");
    const result = (await mod.default.execute(
      { subject: "Real ticket" },
      ctxWith(async (url, init) => {
        requestedUrl = String(url);
        authHeader = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response(JSON.stringify({ id: 4242 }));
      }),
    )) as Record<string, unknown>;
    const ticket = result.ticket as Record<string, unknown>;
    expect(requestedUrl).toBe("https://rt.example.ch/REST/2.0/ticket");
    expect(authHeader).toBe("token secret-token");
    expect(ticket.source).toBe("rt");
    expect(ticket.id).toBe("4242");
    expect(String(ticket.url)).toContain("id=4242");
  });

  test("real path: non-OK throws", async () => {
    setEnv("TICKET_API_URL", "https://rt.example.ch");
    setEnv("TICKET_API_TOKEN", "secret-token");
    const mod = await import("../examples/soc-demo/blocks/A_OPEN_TICKET/action");
    await expect(
      mod.default.execute({ subject: "Bad" }, ctxWith(async () => new Response("nope", { status: 500 }))),
    ).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// 7. A_SHARE_MISP — stub-safe env-gated adapter
// ---------------------------------------------------------------------------

describe("A_SHARE_MISP", () => {
  test("stub path: env unset renders event with null id, no fetch", async () => {
    setEnv("MISP_URL", undefined);
    setEnv("MISP_API_KEY", undefined);
    let fetchCalled = false;
    const mod = await import("../examples/soc-demo/blocks/A_SHARE_MISP/action");
    const result = (await mod.default.execute(
      {
        title: "Phishing infra",
        iocs: {
          urls: ["https://evil.example.com/x"],
          domains: ["evil.example.com"],
          ips: ["192.168.10.5"],
          hashes: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        },
        tlp: { marking: "TLP:AMBER" },
        keep: "k",
      },
      ctxWith(async () => {
        fetchCalled = true;
        return new Response("{}");
      }),
    )) as Record<string, unknown>;
    const misp = result.misp as Record<string, unknown>;
    const event = misp.event as Record<string, unknown>;
    expect(misp.source).toBe("stub");
    expect(misp.event_id).toBeNull();
    expect(fetchCalled).toBe(false);
    expect(event.distribution).toBe(0);
    expect(event.threat_level_id).toBe(2);
    expect(event.analysis).toBe(0);
    expect(event.info).toBe("Phishing infra");
    expect((event.Attribute as unknown[]).length).toBe(4); // url + domain + ip + hash
    expect((event.Tag as { name: string }[])[0].name).toBe("tlp:amber"); // lowercased
    // sha256 attribute typed correctly
    const hashAttr = (event.Attribute as { type: string; value: string }[]).find((a) => a.value.length === 64);
    expect(hashAttr?.type).toBe("sha256");
    expect(result.keep).toBe("k"); // passthrough
  });

  test("accepts bare-string tlp", async () => {
    setEnv("MISP_URL", undefined);
    setEnv("MISP_API_KEY", undefined);
    const mod = await import("../examples/soc-demo/blocks/A_SHARE_MISP/action");
    const result = (await mod.default.execute({ title: "t", tlp: "TLP:RED" }, ctxWith())) as Record<string, unknown>;
    const event = (result.misp as Record<string, unknown>).event as Record<string, unknown>;
    expect((event.Tag as { name: string }[])[0].name).toBe("tlp:red");
  });

  test("real path (mocked): POSTs to /events with API-key auth, parses Event.id", async () => {
    setEnv("MISP_URL", "https://misp.example.ch");
    setEnv("MISP_API_KEY", "misp-key");
    let requestedUrl = "";
    let authHeader = "";
    const mod = await import("../examples/soc-demo/blocks/A_SHARE_MISP/action");
    const result = (await mod.default.execute(
      { title: "Real event", iocs: { domains: ["bad.actor.net"] } },
      ctxWith(async (url, init) => {
        requestedUrl = String(url);
        authHeader = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response(JSON.stringify({ Event: { id: "987" } }));
      }),
    )) as Record<string, unknown>;
    const misp = result.misp as Record<string, unknown>;
    expect(requestedUrl).toBe("https://misp.example.ch/events");
    expect(authHeader).toBe("misp-key");
    expect(misp.source).toBe("misp");
    expect(misp.event_id).toBe("987");
  });

  test("real path: non-OK throws", async () => {
    setEnv("MISP_URL", "https://misp.example.ch");
    setEnv("MISP_API_KEY", "misp-key");
    const mod = await import("../examples/soc-demo/blocks/A_SHARE_MISP/action");
    await expect(
      mod.default.execute({ title: "Bad" }, ctxWith(async () => new Response("denied", { status: 403 }))),
    ).rejects.toThrow("403");
  });
});
