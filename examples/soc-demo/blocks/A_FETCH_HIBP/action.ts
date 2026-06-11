/**
 * A_FETCH_HIBP — email/domain breach check via Have I Been Pwned v3.
 *
 * SOC demo palette block (design/soc-demo-mm-composer.md §4). Follows the
 * stub-safe scaffold of the reference block A_FETCH_VIRUSTOTAL: env-checked at
 * execute time, deterministic fixture when HIBP_API_KEY is missing. The demo
 * must run offline; a missing key is a documented mode, not an error.
 *
 * Real-path note: HIBP returns 404 for an account with no breaches. That is a
 * negative result (breached: false, empty list), NOT a failure — only other
 * non-OK statuses throw.
 */

import type { ActionContext } from "../../../../src/types/action";

interface HibpBreach {
  name: string;
  domain: string;
  breach_date: string;
}

interface HibpResult {
  email: string;
  breached: boolean;
  breaches: HibpBreach[];
  source: "hibp" | "stub";
}

/** Canned response — design §4 fixture: 2 breaches for any email. */
function stubResult(email: string): HibpResult {
  return {
    email,
    breached: true,
    breaches: [
      { name: "ExampleBreach2024", domain: "example.com", breach_date: "2024-03-12" },
      { name: "DemoLeak2025", domain: "demo.example", breach_date: "2025-01-08" },
    ],
    source: "stub",
  };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { email, ...payload } = input;
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("A_FETCH_HIBP: email must be a non-empty string");
    }

    const apiKey = process.env.HIBP_API_KEY;
    if (!apiKey) {
      console.log(`[A_FETCH_HIBP] stub mode (HIBP_API_KEY unset) — would query Have I Been Pwned for ${email}`);
      return { ...payload, hibp: stubResult(email) };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_FETCH_HIBP: fetch capability not injected");

    const endpoint = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(
      email,
    )}?truncateResponse=false`;
    const res = await fetchFn(endpoint, { headers: { "hibp-api-key": apiKey } });

    // 404 = account not found in any breach: a negative result, not an error.
    if (res.status === 404) {
      const hibp: HibpResult = { email, breached: false, breaches: [], source: "hibp" };
      return { ...payload, hibp };
    }
    if (!res.ok) {
      throw new Error(`A_FETCH_HIBP: Have I Been Pwned returned ${res.status} for ${email}`);
    }

    const body = (await res.json()) as Array<{ Name?: string; Domain?: string; BreachDate?: string }>;
    const breaches: HibpBreach[] = (Array.isArray(body) ? body : []).map((b) => ({
      name: b.Name ?? "",
      domain: b.Domain ?? "",
      breach_date: b.BreachDate ?? "",
    }));

    const hibp: HibpResult = {
      email,
      breached: breaches.length > 0,
      breaches,
      source: "hibp",
    };
    return { ...payload, hibp };
  },
};
