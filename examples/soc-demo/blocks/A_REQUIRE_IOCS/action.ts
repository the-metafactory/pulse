/**
 * A_REQUIRE_IOCS — deterministic empty-IOC guard.
 *
 * The failure this prevents (observed live, 2026-06-16): a flow received a
 * message with no indicators, A_EXTRACT_IOCS produced empty arrays, the triage
 * agent was handed nothing and HALLUCINATED example IPs (8.8.8.8 /
 * 192.168.1.100), and the advisory formatter faithfully published the
 * hallucination. Prompt hardening reduces this but can't guarantee it — an LLM
 * may still invent. This block makes it impossible: if extraction surfaced no
 * IOC of any kind, the pipeline fails LOUDLY here, before any triage/advisory
 * step runs. A visible "no IOCs" error beats a confident, fabricated advisory.
 *
 * Pure, offline, no capabilities. Passthrough (payload unchanged) when at least
 * one indicator is present.
 */

import type { ActionContext } from "../../../../src/types/action";

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const counts = {
      ips: asArray(input.ips).length,
      domains: asArray(input.domains).length,
      urls: asArray(input.urls).length,
      hashes: asArray(input.hashes).length,
    };
    const total = counts.ips + counts.domains + counts.urls + counts.hashes;

    if (total === 0) {
      throw new Error(
        "A_REQUIRE_IOCS: no indicators of compromise were extracted from the input " +
          "(0 ips, 0 domains, 0 urls, 0 hashes). Refusing to triage or advise on an " +
          "empty payload — supply a real IOC (e.g. an IP, URL, domain, or hash). " +
          "This guard exists so a triage agent can never invent indicators.",
      );
    }

    console.log(
      `🔎 [A_REQUIRE_IOCS] ${total} IOC(s) present (ips=${counts.ips} domains=${counts.domains} urls=${counts.urls} hashes=${counts.hashes}) — proceeding`,
    );
    // Passthrough: the guard adds nothing to the payload.
    return { ...input };
  },
};
