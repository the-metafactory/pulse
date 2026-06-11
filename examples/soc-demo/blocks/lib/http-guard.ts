/**
 * Shared SSRF guard for soc-demo blocks that fetch attacker-influenceable
 * URLs (feed URLs, feed-item links). Static-host checks: http(s) only,
 * loopback / RFC-1918 / link-local (incl. cloud metadata) / CG-NAT /
 * IPv4-mapped-IPv6 / integer-and-octal IPv4 literals rejected.
 *
 * Scope: static-host bypasses only. DNS rebinding (a public hostname
 * resolving to a private address) is NOT covered — that needs resolver-level
 * control and is out of scope for a demo ingress block.
 *
 * fetchPublic() additionally re-validates every redirect hop: fetch defaults
 * to following redirects, so guarding only the initial URL lets a public
 * 302 bounce into 169.254.169.254. We follow manually, max 5 hops.
 *
 * Lives in blocks/lib/ — no action.json, so the catalog scanner skips it.
 */

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./, // loopback /8
  /^0\./, // 0.0.0.0/8 routes to localhost on Linux
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local incl. cloud metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CG-NAT 100.64/10
  /^::1$/,
  /^(0:){7}0*1$/, // expanded IPv6 loopback
  /^::ffff:/, // IPv4-mapped IPv6 (covers ::ffff:127.0.0.1 etc.)
  /^f[cd][0-9a-f]{2}:/, // IPv6 unique-local
  /^fe80:/, // IPv6 link-local
];

/** Hostname that is a bare integer / octal / hex IPv4 literal (2130706433 ≡ 127.0.0.1). */
function isNumericIpLiteral(host: string): boolean {
  if (/^\d+$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  // dotted forms with leading zeros (octal interpretation in inet_aton)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").some((o) => o.length > 1 && o.startsWith("0"))) {
    return true;
  }
  return false;
}

export function assertPublicHttpUrl(raw: string, blockName: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_err) {
    throw new Error(`${blockName}: not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${blockName}: URL must be http(s), got ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host)) || isNumericIpLiteral(host)) {
    throw new Error(`${blockName}: URL targets a private/loopback/literal host: ${host}`);
  }
  return url;
}

/**
 * fetch with the guard applied to the initial URL AND every redirect hop.
 * Returns the final response (non-redirect). Max 5 hops.
 */
export async function fetchPublic(
  fetchFn: typeof globalThis.fetch,
  rawUrl: string,
  init: RequestInit,
  blockName: string,
): Promise<Response> {
  let current = assertPublicHttpUrl(rawUrl, blockName).toString();
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetchFn(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      const next = new URL(location, current).toString();
      current = assertPublicHttpUrl(next, blockName).toString();
      continue;
    }
    return res;
  }
  throw new Error(`${blockName}: too many redirects fetching ${rawUrl}`);
}
