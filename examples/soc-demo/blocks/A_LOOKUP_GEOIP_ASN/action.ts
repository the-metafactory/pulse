/**
 * A_LOOKUP_GEOIP_ASN — offline IP → country + ASN enrichment.
 *
 * D-class block for the SOC demo palette (design/soc-demo-mm-composer.md §4):
 * a MaxMind-lite lookup against an embedded table of demo IPs. No env, no
 * network, no capabilities — pure and deterministic so demo flows run fully
 * offline. An unknown IP is a documented result ({ known: false }), never an
 * error: enrichment that can't identify an address should say so, not crash
 * the pipeline.
 */

import type { ActionContext } from "../../../../src/types/action";
import { GEOIP_TABLE } from "./fixtures";

interface GeoIpResult {
  ip: string;
  country: string;
  asn: number;
  as_org: string;
  known: boolean;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { ip, ...payload } = input;
    if (typeof ip !== "string" || ip.length === 0) {
      throw new Error("A_LOOKUP_GEOIP_ASN: ip must be a non-empty string");
    }

    const hit = GEOIP_TABLE[ip.trim()];
    const geoip: GeoIpResult = hit
      ? { ip, country: hit.country, asn: hit.asn, as_org: hit.as_org, known: true }
      : { ip, country: "??", asn: 0, as_org: "unknown", known: false };

    return { ...payload, geoip };
  },
};
