/**
 * A_FETCH_URLSCAN — submit a URL for scanning via urlscan.io.
 *
 * SOC demo palette block (design/soc-demo-mm-composer.md §4). Follows the
 * stub-safe scaffold of the reference block A_FETCH_VIRUSTOTAL: env-checked at
 * execute time, deterministic fixture when URLSCAN_API_KEY is missing. The demo
 * must run offline; a missing key is a documented mode, not an error.
 *
 * Real-path note: urlscan.io scanning is asynchronous — a POST submits the scan
 * and returns a uuid, but the verdict is not ready immediately. We stay honest:
 * on the real path the verdict is "submitted" with score 0, and we derive the
 * result/screenshot URLs from the returned uuid. The demo itself runs in stub
 * mode, where a canned malicious verdict tells the richer story.
 */

import type { ActionContext } from "../../../../src/types/action";

interface UrlscanResult {
  url: string;
  verdict: "malicious" | "suspicious" | "benign" | "submitted";
  score: number;
  screenshot_url: string | null;
  report_url: string | null;
  source: "urlscan" | "stub";
}

/** Canned response — design §4 fixture: malicious verdict, score 85. */
function stubResult(url: string): UrlscanResult {
  return {
    url,
    verdict: "malicious",
    score: 85,
    screenshot_url: "https://urlscan.io/screenshots/stub.png",
    report_url: "https://urlscan.io/result/stub/",
    source: "stub",
  };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { url, ...payload } = input;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("A_FETCH_URLSCAN: url must be a non-empty string");
    }

    const apiKey = process.env.URLSCAN_API_KEY;
    if (!apiKey) {
      console.log(`[A_FETCH_URLSCAN] stub mode (URLSCAN_API_KEY unset) — would submit ${url} to urlscan.io`);
      return { ...payload, urlscan: stubResult(url) };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_FETCH_URLSCAN: fetch capability not injected");

    const res = await fetchFn("https://urlscan.io/api/v1/scan/", {
      method: "POST",
      headers: { "API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ url, visibility: "unlisted" }),
    });
    if (!res.ok) {
      throw new Error(`A_FETCH_URLSCAN: urlscan.io returned ${res.status} for ${url}`);
    }

    const body = (await res.json()) as { uuid?: string };
    const uuid = body.uuid ?? null;

    const urlscan: UrlscanResult = {
      url,
      verdict: "submitted",
      score: 0,
      screenshot_url: uuid ? `https://urlscan.io/screenshots/${uuid}.png` : null,
      report_url: uuid ? `https://urlscan.io/result/${uuid}/` : null,
      source: "urlscan",
    };
    return { ...payload, urlscan };
  },
};
