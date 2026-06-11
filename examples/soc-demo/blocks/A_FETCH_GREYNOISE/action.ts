/**
 * A_FETCH_GREYNOISE — IP background-noise / scanner reputation via the
 * GreyNoise community API.
 *
 * SOC demo palette block (design/soc-demo-mm-composer.md §4). Follows the
 * stub-safe scaffold of the reference block A_FETCH_VIRUSTOTAL: env-checked at
 * execute time, deterministic fixture when GREYNOISE_API_KEY is missing. The
 * demo must run offline; a missing key is a documented mode, not an error.
 *
 * Real-path note: GreyNoise returns 404 for an IP it has never observed. That
 * is a negative result (noise: false, classification "unknown"), NOT a failure
 * — only other non-OK statuses throw.
 */

import type { ActionContext } from "../../../../src/types/action";

interface GreynoiseResult {
  ip: string;
  noise: boolean;
  riot: boolean;
  classification: string;
  name: string | null;
  source: "greynoise" | "stub";
}

/** Canned response — design §4 fixture: known scanner, Censys. */
function stubResult(ip: string): GreynoiseResult {
  return {
    ip,
    noise: true,
    riot: false,
    classification: "benign",
    name: "Censys",
    source: "stub",
  };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { ip, ...payload } = input;
    if (typeof ip !== "string" || ip.length === 0) {
      throw new Error("A_FETCH_GREYNOISE: ip must be a non-empty string");
    }

    const apiKey = process.env.GREYNOISE_API_KEY;
    if (!apiKey) {
      console.log(`[A_FETCH_GREYNOISE] stub mode (GREYNOISE_API_KEY unset) — would query GreyNoise for ${ip}`);
      return { ...payload, greynoise: stubResult(ip) };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_FETCH_GREYNOISE: fetch capability not injected");

    const endpoint = `https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`;
    const res = await fetchFn(endpoint, { headers: { key: apiKey } });

    // 404 = IP not observed by GreyNoise: a negative result, not an error.
    if (res.status === 404) {
      const greynoise: GreynoiseResult = {
        ip,
        noise: false,
        riot: false,
        classification: "unknown",
        name: null,
        source: "greynoise",
      };
      return { ...payload, greynoise };
    }
    if (!res.ok) {
      throw new Error(`A_FETCH_GREYNOISE: GreyNoise returned ${res.status} for ${ip}`);
    }

    const body = (await res.json()) as {
      noise?: boolean;
      riot?: boolean;
      classification?: string;
      name?: string;
    };

    const greynoise: GreynoiseResult = {
      ip,
      noise: body.noise ?? false,
      riot: body.riot ?? false,
      classification: body.classification ?? "unknown",
      name: body.name ?? null,
      source: "greynoise",
    };
    return { ...payload, greynoise };
  },
};
