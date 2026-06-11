/**
 * A_LOOKUP_CVE — offline CVE → CVSS + KEV status enrichment.
 *
 * D-class block for the SOC demo palette (design/soc-demo-mm-composer.md §4):
 * an NVD-lite lookup against an embedded cache of well-known CVEs. No env, no
 * network, no capabilities — pure and deterministic so demo flows run fully
 * offline. The CVE id is case-normalized to upper-case before lookup. An
 * unknown CVE is a documented result ({ known: false, kev: false, cvss: 0 }),
 * never an error.
 */

import type { ActionContext } from "../../../../src/types/action";
import { CVE_CACHE, severityFor } from "./fixtures";

interface CveInfo {
  cve: string;
  cvss: number;
  severity: string;
  kev: boolean;
  summary: string;
  known: boolean;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { cve, ...payload } = input;
    if (typeof cve !== "string" || cve.length === 0) {
      throw new Error("A_LOOKUP_CVE: cve must be a non-empty string");
    }

    const id = cve.trim().toUpperCase();
    const hit = CVE_CACHE[id];
    const cve_info: CveInfo = hit
      ? { cve: id, cvss: hit.cvss, severity: severityFor(hit.cvss), kev: hit.kev, summary: hit.summary, known: true }
      : { cve: id, cvss: 0, severity: severityFor(0), kev: false, summary: "no offline record for this CVE", known: false };

    return { ...payload, cve_info };
  },
};
