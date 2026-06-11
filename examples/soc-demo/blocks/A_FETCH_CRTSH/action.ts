/**
 * A_FETCH_CRTSH — certificate-transparency search via crt.sh
 * (typosquat / shadow-IT discovery).
 *
 * SOC demo palette block (design/soc-demo-mm-composer.md §4). Follows the
 * stub-safe scaffold of the reference block A_FETCH_VIRUSTOTAL, with ONE
 * deliberate divergence: crt.sh is keyless, so there is no API key to gate on.
 * Instead the stub gate is the CRTSH_LIVE env flag — unset (or anything other
 * than "1") returns the canned fixture; CRTSH_LIVE=1 performs the live query.
 * The demo must run offline; the default (no flag) is the deterministic fixture.
 */

import type { ActionContext } from "../../../../src/types/action";

interface CrtshCertificate {
  issuer: string;
  common_name: string;
  not_before: string;
  not_after: string;
}

interface CrtshResult {
  domain: string;
  certificates: CrtshCertificate[];
  count: number;
  source: "crtsh" | "stub";
}

/** Canned response — design §4 fixture: 2 certs for the queried domain. */
function stubResult(domain: string): CrtshResult {
  const certificates: CrtshCertificate[] = [
    {
      issuer: "R3",
      common_name: domain,
      not_before: "2025-01-01T00:00:00",
      not_after: "2025-04-01T00:00:00",
    },
    {
      issuer: "R3",
      common_name: `login.${domain}`,
      not_before: "2025-02-15T00:00:00",
      not_after: "2025-05-15T00:00:00",
    },
  ];
  return { domain, certificates, count: certificates.length, source: "stub" };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { domain, ...payload } = input;
    if (typeof domain !== "string" || domain.length === 0) {
      throw new Error("A_FETCH_CRTSH: domain must be a non-empty string");
    }

    // Keyless service: the stub gate is CRTSH_LIVE=1, not an API key.
    if (process.env.CRTSH_LIVE !== "1") {
      console.log(`[A_FETCH_CRTSH] stub mode (CRTSH_LIVE unset) — would query crt.sh for ${domain}`);
      return { ...payload, crtsh: stubResult(domain) };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_FETCH_CRTSH: fetch capability not injected");

    const endpoint = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
    const res = await fetchFn(endpoint);
    if (!res.ok) {
      throw new Error(`A_FETCH_CRTSH: crt.sh returned ${res.status} for ${domain}`);
    }

    const body = (await res.json()) as Array<{
      issuer_name?: string;
      common_name?: string;
      not_before?: string;
      not_after?: string;
    }>;

    const certificates: CrtshCertificate[] = (Array.isArray(body) ? body : [])
      .slice(0, 25)
      .map((c) => ({
        issuer: c.issuer_name ?? "",
        common_name: c.common_name ?? "",
        not_before: c.not_before ?? "",
        not_after: c.not_after ?? "",
      }));

    const crtsh: CrtshResult = {
      domain,
      certificates,
      count: certificates.length,
      source: "crtsh",
    };
    return { ...payload, crtsh };
  },
};
