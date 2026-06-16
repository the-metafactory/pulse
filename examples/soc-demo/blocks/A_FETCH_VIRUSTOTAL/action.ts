/**
 * A_FETCH_VIRUSTOTAL — URL / domain / IP / file-hash reputation via VirusTotal v3.
 *
 * Reference block for the SOC demo palette (design/soc-demo-mm-composer.md §8.2):
 * every external adapter follows this shape — env-checked at execute time,
 * deterministic fixture response when the key is missing (the stub-safe
 * contract, mirroring A_NOTIFY_MATTERMOST's env-skip pattern). The demo must
 * run offline; a missing key is a documented mode, not an error.
 *
 * Accepts `ioc` OR `ip` — so it drops into a per-IP enrichment map (where the
 * field is `ip`) as well as a generic IOC pipeline. IPv4 → the v3
 * `/ip_addresses/` endpoint (not `/domains/`, which an IP would otherwise hit).
 */

import type { ActionContext } from "../../../../src/types/action";

interface VtVerdict {
  ioc: string;
  ioc_type: "hash" | "url" | "domain" | "ip";
  malicious: number;
  total_vendors: number;
  verdict: "malicious" | "suspicious" | "clean";
  source: "virustotal" | "stub";
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function detectIocType(ioc: string): VtVerdict["ioc_type"] {
  if (IPV4_RE.test(ioc)) return "ip";
  if (/^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(ioc)) return "hash";
  if (/^https?:\/\//i.test(ioc)) return "url";
  return "domain";
}

function endpointFor(iocType: VtVerdict["ioc_type"], ioc: string): string {
  switch (iocType) {
    case "hash":
      return `https://www.virustotal.com/api/v3/files/${ioc}`;
    case "url":
      return `https://www.virustotal.com/api/v3/urls/${Buffer.from(ioc).toString("base64url")}`;
    case "ip":
      return `https://www.virustotal.com/api/v3/ip_addresses/${ioc}`;
    case "domain":
      return `https://www.virustotal.com/api/v3/domains/${ioc}`;
  }
}

function verdictFor(malicious: number): VtVerdict["verdict"] {
  if (malicious >= 3) return "malicious";
  if (malicious >= 1) return "suspicious";
  return "clean";
}

/** Canned response — design §4 fixture: 3/70 vendors flagged. */
function stubVerdict(ioc: string): VtVerdict {
  return {
    ioc,
    ioc_type: detectIocType(ioc),
    malicious: 3,
    total_vendors: 70,
    verdict: "malicious",
    source: "stub",
  };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { ioc, ...payload } = input;
    // Accept `ioc` or (in a per-IP map) `ip`. `ip` stays in the payload so the
    // map's collect keeps it alongside the verdict.
    const target =
      typeof ioc === "string" && ioc.length > 0
        ? ioc
        : typeof payload.ip === "string" && (payload.ip as string).length > 0
          ? (payload.ip as string)
          : undefined;
    if (target === undefined) {
      throw new Error("A_FETCH_VIRUSTOTAL: needs a non-empty `ioc` or `ip`");
    }

    const apiKey = process.env.VT_API_KEY;
    if (!apiKey) {
      console.log(`[A_FETCH_VIRUSTOTAL] stub mode (VT_API_KEY unset) — would query VirusTotal for ${target}`);
      return { ...payload, vt_verdict: stubVerdict(target) };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_FETCH_VIRUSTOTAL: fetch capability not injected");

    const iocType = detectIocType(target);
    const res = await fetchFn(endpointFor(iocType, target), { headers: { "x-apikey": apiKey } });
    if (!res.ok) {
      throw new Error(`A_FETCH_VIRUSTOTAL: VirusTotal returned ${res.status} for ${target}`);
    }
    const body = (await res.json()) as {
      data?: { attributes?: { last_analysis_stats?: Record<string, number> } };
    };
    const stats = body.data?.attributes?.last_analysis_stats ?? {};
    const malicious = stats.malicious ?? 0;
    const total = Object.values(stats).reduce((a, b) => a + b, 0);

    const vt_verdict: VtVerdict = {
      ioc: target,
      ioc_type: iocType,
      malicious,
      total_vendors: total,
      verdict: verdictFor(malicious),
      source: "virustotal",
    };
    return { ...payload, vt_verdict };
  },
};
