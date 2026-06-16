/**
 * A_FORMAT_IP_ADVISORY — renders an IP investigation into an advisory_doc.
 *
 * Locks the demo-critical guarantees: the advisory reflects the REAL enriched
 * IPs (never fixtures), an empty-IOC run is honest rather than invented, the
 * IP-investigation headline is used (not the phishing one), and payload passes
 * through so a downstream A_NOTIFY_MATTERMOST sees advisory_doc.
 */

import { describe, expect, test } from "bun:test";
import { ctxWith } from "./helpers/soc-demo-test-helpers";

const mod = () => import("../examples/soc-demo/blocks/A_FORMAT_IP_ADVISORY/action");

const ENRICHMENT = [
  {
    ip: "167.71.70.184",
    geoip: { ip: "167.71.70.184", country: "US", asn: 14061, as_org: "DigitalOcean", known: true },
    owner: { abuse_contact: "abuse@digitalocean.com" },
    greynoise: { noise: true, riot: false, classification: "malicious" },
  },
];

describe("A_FORMAT_IP_ADVISORY", () => {
  test("renders the REAL enriched IP, not fixtures; IP-investigation headline", async () => {
    const m = await mod();
    const out = (await m.default.execute(
      {
        triage: { verdict: "malicious", advisory: "Scanner IP with GreyNoise hits." },
        ip_enrichment: ENRICHMENT,
        ips: ["167.71.70.184"],
        approval: { name: "analyst-review", verdict: "pass", notes: "approved", closed_at: "2026-06-16T11:00:00Z" },
      },
      ctxWith(),
    )) as Record<string, unknown>;

    const doc = out.advisory_doc as { markdown: string; subject: string };
    expect(doc.markdown).toContain("IP Investigation");
    expect(doc.markdown).toContain("167.71.70.184");
    expect(doc.markdown).toContain("DigitalOcean");
    expect(doc.markdown).toContain("GreyNoise: malicious");
    expect(doc.markdown).toContain("verdict: **malicious**");
    expect(doc.subject).toContain("IP Investigation Advisory");
    // No phishing-template leakage, no fixture IPs.
    expect(doc.markdown).not.toContain("Phishing Campaign");
    expect(doc.markdown).not.toContain("8.8.8.8");
  });

  test("string (raw LLM) triage is parsed as prose, never crashes", async () => {
    const m = await mod();
    const out = (await m.default.execute(
      { triage: "Benign scanner, no action needed.", ip_enrichment: ENRICHMENT, ips: ["167.71.70.184"] },
      ctxWith(),
    )) as Record<string, unknown>;
    const doc = out.advisory_doc as { markdown: string };
    expect(doc.markdown).toContain("Benign scanner");
    expect(doc.markdown).toContain("167.71.70.184");
  });

  test("empty enrichment + empty IOCs: honest 'no' rendering, no invented data", async () => {
    const m = await mod();
    const out = (await m.default.execute(
      { triage: { verdict: "unknown" }, ip_enrichment: [], ips: [] },
      ctxWith(),
    )) as Record<string, unknown>;
    const doc = out.advisory_doc as { markdown: string };
    expect(doc.markdown).not.toContain("Per-IP enrichment");
    expect(doc.markdown).not.toContain("8.8.8.8");
    expect(doc.markdown).not.toContain("192.168.1.100");
  });

  test("missing triage throws (fail loud, not a blank advisory)", async () => {
    const m = await mod();
    expect(m.default.execute({ ip_enrichment: ENRICHMENT }, ctxWith())).rejects.toThrow(/triage is required/);
  });

  test("passes payload through and emits advisory_doc for the next step", async () => {
    const m = await mod();
    const out = (await m.default.execute(
      { triage: { verdict: "benign" }, ip_enrichment: ENRICHMENT, case_id: "c-42" },
      ctxWith(),
    )) as Record<string, unknown>;
    expect(out.case_id).toBe("c-42");
    expect(out.advisory_doc).toBeDefined();
  });
});
