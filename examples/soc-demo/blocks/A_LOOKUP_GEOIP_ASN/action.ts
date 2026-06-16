/**
 * A_LOOKUP_GEOIP_ASN — IP → country + ASN enrichment.
 *
 * Fixture-first, live-fallback (design/soc-demo-mm-composer.md §4):
 *   1. Embedded demo table (SWITCH, Hetzner, OVH, Cloudflare, scanners…) —
 *      instant, offline, deterministic for the known demo IPs + tests.
 *   2. Otherwise, if a `fetch` capability is present, a LIVE lookup against
 *      ipwho.is — a free, keyless, HTTPS geo/ASN service. country_code + ASN +
 *      org map straight onto our result.
 *   3. On no capability (offline), a non-IPv4 input, a non-OK/unsuccessful
 *      response, or any network error: `{ known: false }`. Enrichment that
 *      can't identify an address says so — it never throws and never stalls
 *      the pipeline.
 *
 * The looked-up IP is only ever a PATH segment of the fixed ipwho.is host
 * (encodeURIComponent'd), so an attacker-influenced IOC can't redirect the
 * request elsewhere — no SSRF surface, no host guard needed.
 */

import type { ActionContext } from "../../../../src/types/action";
import { GEOIP_TABLE } from "./fixtures";

interface GeoIpResult {
  ip: string;
  country: string;
  asn: number;
  as_org: string;
  known: boolean;
  source?: "fixture" | "ipwho.is";
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LOOKUP_TIMEOUT_MS = 5000;

const UNKNOWN = (ip: string): GeoIpResult => ({
  ip,
  country: "??",
  asn: 0,
  as_org: "unknown",
  known: false,
});

/** Live keyless lookup via ipwho.is; null on any failure (caller → UNKNOWN). */
async function liveLookup(
  ip: string,
  fetchFn: typeof globalThis.fetch,
): Promise<GeoIpResult | null> {
  try {
    const res = await fetchFn(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as {
      success?: boolean;
      country_code?: string;
      connection?: { asn?: number; org?: string; isp?: string };
    };
    if (b.success !== true) return null; // ipwho.is signals failure in-band
    return {
      ip,
      country: b.country_code && b.country_code.length > 0 ? b.country_code : "??",
      asn: typeof b.connection?.asn === "number" ? b.connection.asn : 0,
      as_org: b.connection?.org ?? b.connection?.isp ?? "unknown",
      known: true,
      source: "ipwho.is",
    };
  } catch (_err) {
    // Timeout / offline / malformed JSON — a live lookup failure is a negative
    // result (known:false), never a pipeline error.
    return null;
  }
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { ip, ...payload } = input;
    if (typeof ip !== "string" || ip.length === 0) {
      throw new Error("A_LOOKUP_GEOIP_ASN: ip must be a non-empty string");
    }
    const addr = ip.trim();

    // 1. Fixture fast-path (offline, deterministic, demo + test IPs).
    const hit = GEOIP_TABLE[addr];
    if (hit) {
      return {
        ...payload,
        geoip: { ip, country: hit.country, asn: hit.asn, as_org: hit.as_org, known: true, source: "fixture" },
      };
    }

    // 2. Live fallback — only with a fetch capability and a real IPv4.
    const fetchFn = ctx.capabilities.fetch;
    if (fetchFn && IPV4_RE.test(addr)) {
      const live = await liveLookup(addr, fetchFn);
      if (live) return { ...payload, geoip: live };
    }

    // 3. Unknown — offline, non-IPv4, or live lookup failed.
    return { ...payload, geoip: UNKNOWN(ip) };
  },
};
