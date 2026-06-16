/**
 * Live-lookup behaviour for the IP-investigation enrichment blocks:
 *   - A_LOOKUP_GEOIP_ASN: fixture-first, then keyless ipwho.is, graceful on fail.
 *   - A_FETCH_VIRUSTOTAL: handles IPs (ip alias + /ip_addresses/ endpoint), stub-safe.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ctxWith, setEnv, restoreEnv } from "./helpers/soc-demo-test-helpers";

const geoip = () => import("../examples/soc-demo/blocks/A_LOOKUP_GEOIP_ASN/action");
const vt = () => import("../examples/soc-demo/blocks/A_FETCH_VIRUSTOTAL/action");

afterEach(() => restoreEnv());

describe("A_LOOKUP_GEOIP_ASN — fixture-first, live ipwho.is fallback", () => {
  test("fixture IP resolves offline without ever calling fetch", async () => {
    const m = await geoip();
    let fetched = false;
    const ctx = ctxWith(async () => { fetched = true; return new Response("{}"); });
    const out = (await m.default.execute({ ip: "130.59.1.1" }, ctx)) as Record<string, unknown>;
    const g = out.geoip as Record<string, unknown>;
    expect(g.known).toBe(true);
    expect(g.as_org).toBe("SWITCH");
    expect(g.source).toBe("fixture");
    expect(fetched).toBe(false); // fixture short-circuits the network
  });

  test("non-fixture IP → live ipwho.is, mapped to country/asn/org", async () => {
    const m = await geoip();
    const ctx = ctxWith(async (url) => {
      expect(url).toContain("ipwho.is/167.71.70.184");
      return new Response(JSON.stringify({
        success: true,
        country_code: "NL",
        connection: { asn: 14061, org: "DigitalOcean, LLC", isp: "DigitalOcean, LLC" },
      }));
    });
    const out = (await m.default.execute({ ip: "167.71.70.184" }, ctx)) as Record<string, unknown>;
    const g = out.geoip as Record<string, unknown>;
    expect(g).toMatchObject({ country: "NL", asn: 14061, as_org: "DigitalOcean, LLC", known: true, source: "ipwho.is" });
  });

  test("ipwho.is in-band failure (success:false) → known:false, never throws", async () => {
    const m = await geoip();
    const ctx = ctxWith(async () => new Response(JSON.stringify({ success: false, message: "reserved range" })));
    const out = (await m.default.execute({ ip: "10.0.0.1" }, ctx)) as Record<string, unknown>;
    expect((out.geoip as Record<string, unknown>).known).toBe(false);
  });

  test("network error → known:false (graceful, no pipeline crash)", async () => {
    const m = await geoip();
    const ctx = ctxWith(async () => { throw new Error("offline"); });
    const out = (await m.default.execute({ ip: "203.0.113.9" }, ctx)) as Record<string, unknown>;
    expect((out.geoip as Record<string, unknown>).known).toBe(false);
  });

  test("no fetch capability → known:false (fully offline)", async () => {
    const m = await geoip();
    const out = (await m.default.execute({ ip: "203.0.113.9" }, ctxWith())) as Record<string, unknown>;
    expect((out.geoip as Record<string, unknown>).known).toBe(false);
  });
});

describe("A_FETCH_VIRUSTOTAL — IP support", () => {
  test("accepts `ip` (no ioc) and queries the /ip_addresses/ endpoint", async () => {
    setEnv("VT_API_KEY", "test-key");
    const m = await vt();
    const ctx = ctxWith(async (url) => {
      expect(url).toBe("https://www.virustotal.com/api/v3/ip_addresses/167.71.70.184");
      return new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 5, harmless: 60, suspicious: 1 } } } }));
    });
    const out = (await m.default.execute({ ip: "167.71.70.184" }, ctx)) as Record<string, unknown>;
    const v = out.vt_verdict as Record<string, unknown>;
    expect(v).toMatchObject({ ioc: "167.71.70.184", ioc_type: "ip", malicious: 5, verdict: "malicious", source: "virustotal" });
    expect(v.total_vendors).toBe(66);
    expect(out.ip).toBe("167.71.70.184"); // ip preserved in the payload for collect
  });

  test("stub mode (no key) works for an IP via the `ip` field", async () => {
    const m = await vt();
    const out = (await m.default.execute({ ip: "8.8.8.8" }, ctxWith())) as Record<string, unknown>;
    const v = out.vt_verdict as Record<string, unknown>;
    expect(v).toMatchObject({ ioc: "8.8.8.8", ioc_type: "ip", source: "stub" });
  });

  test("still handles a domain ioc (backward compatible)", async () => {
    const m = await vt();
    const out = (await m.default.execute({ ioc: "evil.example" }, ctxWith())) as Record<string, unknown>;
    expect((out.vt_verdict as Record<string, unknown>).ioc_type).toBe("domain");
  });
});
