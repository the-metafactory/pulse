/**
 * A_SANITIZE_IOCS — the deterministic sovereignty boundary.
 *
 * Takes the local model's triage result (which saw the raw member email) and
 * produces a sanitized IOC set safe for frontier enrichment: recipient
 * addresses and any member-side identifiers are dropped; only attacker
 * infrastructure (URLs, domains, sender addresses, hashes) passes through.
 */

import type { ActionContext } from "../../../src/types/action";
import type { AgentTaskResult } from "../../../src/types/agent";

interface TriageOutput {
  verdict?: string;
  confidence?: number;
  iocs?: {
    urls?: string[];
    domains?: string[];
    senders?: string[];
    hashes?: string[];
  };
  summary?: string;
}

// Member-side patterns that must never leave the SOC.
const INTERNAL_DOMAINS = [/example-university\.ch$/i, /\.switch\.ch$/i];

function isInternal(value: string): boolean {
  return INTERNAL_DOMAINS.some((re) => re.test(value.trim()));
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { triage, ...payload } = input;
    const result = triage as AgentTaskResult;
    const out = (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as TriageOutput;

    const iocs = out.iocs ?? {};
    const sanitized = {
      verdict: out.verdict,
      confidence: out.confidence,
      urls: (iocs.urls ?? []).filter((u) => !isInternal(new URL(u).hostname)),
      domains: (iocs.domains ?? []).filter((d) => !isInternal(d)),
      senders: (iocs.senders ?? []).filter((s) => !isInternal(s.split("@")[1] ?? "")),
      hashes: iocs.hashes ?? [],
    };

    return { ...payload, triage, iocs_sanitized: sanitized };
  },
};
