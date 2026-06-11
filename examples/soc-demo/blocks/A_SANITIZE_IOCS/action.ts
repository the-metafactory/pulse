/**
 * A_SANITIZE_IOCS — deterministic internal-domain filter (demo scope).
 *
 * Takes the local model's triage result (which saw the raw member email) and
 * filters IOCs whose host matches the CONFIGURED internal-domain patterns
 * before frontier enrichment. This is a demo fixture, NOT a general PII
 * boundary: only the patterns in INTERNAL_DOMAINS are dropped — arbitrary
 * member identifiers, names, or unlisted domains pass through untouched.
 * A production deployment must replace the pattern list with its own
 * constituency data (sage PR #40: no overclaiming the sovereignty boundary).
 *
 * Triage output is model-shaped and can contain malformed, relative, or
 * still-defanged URLs — those are dropped, never crash the block.
 */

import type { ActionContext } from "../../../../src/types/action";
import type { AgentTaskResult } from "../../../../src/types/agent";

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

// Configured internal patterns (demo fixture — replace per deployment).
const INTERNAL_DOMAINS = [/example-university\.ch$/i, /\.switch\.ch$/i];

function isInternal(value: string): boolean {
  return INTERNAL_DOMAINS.some((re) => re.test(value.trim()));
}

/** Hostname of a URL, or null when unparseable — caller drops those. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch (_err) {
    // An IOC we can't parse is an IOC we can't safely classify as external.
    return null;
  }
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
      urls: (iocs.urls ?? []).filter((u) => {
        const host = hostnameOf(u);
        return host !== null && !isInternal(host);
      }),
      domains: (iocs.domains ?? []).filter((d) => !isInternal(d)),
      senders: (iocs.senders ?? []).filter((s) => !isInternal(s.split("@")[1] ?? "")),
      hashes: iocs.hashes ?? [],
    };

    return { ...payload, triage, iocs_sanitized: sanitized };
  },
};
