/**
 * A_EXTRACT_IOCS — deterministic, defang-aware IOC extraction.
 *
 * D-class block for the SOC demo palette (design/soc-demo-mm-composer.md §4):
 * the deterministic counterpart to the agentic triage path, so a flow can stay
 * D-only when the operator wants no LLM in the loop. No env, no network, no
 * capabilities — pure and offline.
 *
 * Pipeline: refang the whole text first (hxxp→http, [.]/(.)/{.}→.) so a single
 * set of patterns matches both clean and defanged indicators, then extract
 * URLs, IPv4 addresses (octets validated ≤255), domains, and MD5/SHA1/SHA256
 * hashes. Each category is deduped while preserving first-seen order. Domains
 * that appear as the host of an extracted URL are still listed under domains,
 * so a consumer reading only `domains` doesn't miss them.
 */

import type { ActionContext } from "../../../../src/types/action";

interface Iocs {
  urls: string[];
  domains: string[];
  ips: string[];
  hashes: string[];
}

/** Undo common defanging so one pattern set matches clean + defanged indicators. */
function refang(text: string): string {
  return text
    .replace(/h[x]{2}p(s?):\/\//gi, "http$1://") // hxxp:// / hxxps:// → http(s)://
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, ".") // [.] (.) {.} → .
    .replace(/\[:\]|\(:\)|\{:\}/g, ":") // [:]/(:)/{:} → :  (defanged scheme separators)
    .replace(/\[at\]|\(at\)|\{at\}/gi, "@"); // [at] → @  (helps sender-style indicators)
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
// Trailing punctuation that is almost certainly sentence/markup, not part of the URL.
const URL_TRAILING_RE = /[.,;:!?]+$/;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HASH_RE = /\b[a-fA-F0-9]{32}\b|\b[a-fA-F0-9]{40}\b|\b[a-fA-F0-9]{64}\b/g;
// Domain: at least one label + a 2+ char alphabetic TLD. Conservative on purpose.
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch (_err) {
    // Malformed URL — no host to contribute; the URL itself is still captured.
    return null;
  }
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { text, ...payload } = input;
    if (typeof text !== "string") {
      throw new Error("A_EXTRACT_IOCS: text must be a string");
    }

    const refanged = refang(text);

    const urls = dedupe((refanged.match(URL_RE) ?? []).map((u) => u.replace(URL_TRAILING_RE, "")));
    const ips = dedupe((refanged.match(IPV4_RE) ?? []).filter(isValidIpv4));
    const hashes = dedupe(refanged.match(HASH_RE) ?? []);

    // Domains found free-standing in the text, plus the hosts of extracted URLs.
    const urlHosts = urls.map(hostOf).filter((h): h is string => h !== null);
    const rawDomains = refanged.match(DOMAIN_RE) ?? [];
    // Drop anything that is actually an IPv4 literal (the domain regex can catch them).
    const domains = dedupe([...rawDomains, ...urlHosts].filter((d) => !isValidIpv4(d)));

    // Emit the indicator categories as TOP-LEVEL typed arrays so a downstream
    // scalar-consuming enricher (e.g. A_LOOKUP_GEOIP_ASN needs `ip`) can be fed
    // per-item via `map over: ips as: ip` — the pipe's collection→scalar
    // coercion. `iocs` is kept as the grouped object for back-compat with
    // consumers that read the whole bag (A_TAG_TLP, A_SANITIZE_IOCS).
    const iocs: Iocs = { urls, domains, ips, hashes };
    return { ...payload, iocs, ips, domains, hashes, urls };
  },
};
