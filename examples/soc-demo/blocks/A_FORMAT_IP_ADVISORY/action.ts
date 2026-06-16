/**
 * A_FORMAT_IP_ADVISORY — render an IP investigation into one advisory document.
 *
 * The IP-investigation counterpart to A_FORMAT_ADVISORY (which is phishing-
 * shaped, hardcoded to "Phishing Campaign"). Consumes the triage verdict, the
 * per-IP enrichment list the map step collected (GeoIP / ASN / owner / GreyNoise),
 * the optional TLP tag, and the gate verdict, and renders one markdown document
 * + subject for A_NOTIFY_MATTERMOST / stdout / mail.
 *
 * Pure, offline, shape-tolerant: `triage` may be a string or object (raw LLM
 * output); enrichment entries may carry any subset of geoip/owner/greynoise.
 * NOTHING is invented — only what the pipeline produced is rendered, so an
 * empty-IOC run yields an honest "no indicators" advisory rather than fixtures.
 */

import type { ActionContext } from "../../../../src/types/action";
import type { GateResult } from "../../../../src/types/pipeline";

interface GeoIp {
  ip?: string;
  country?: string;
  asn?: number;
  as_org?: string;
  known?: boolean;
}

interface GreyNoise {
  noise?: boolean;
  riot?: boolean;
  classification?: string;
}

interface VtVerdict {
  verdict?: string;
  malicious?: number;
  total_vendors?: number;
  source?: string;
}

interface IpEnrichment {
  ip?: string;
  geoip?: GeoIp;
  owner?: Record<string, unknown>;
  greynoise?: GreyNoise;
  vt_verdict?: VtVerdict;
}

/** Parse agent output: object as-is; JSON string parsed (edge fences stripped); a ```json block embedded in prose extracted; prose kept raw under `advisory`. */
function parseAgentJson(output: unknown): Record<string, unknown> {
  if (typeof output !== "string") return (output ?? {}) as Record<string, unknown>;
  const cleaned = output.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (_err) {
    const embedded = output.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    if (embedded) {
      try {
        return JSON.parse(embedded[1]!) as Record<string, unknown>;
      } catch (_err2) {
        // fenced block wasn't valid JSON either — fall through to prose
      }
    }
    return { advisory: cleaned };
  }
}

/** "campaign_context" → "Campaign context" */
function titleCase(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Render any model-shaped value as markdown: strings as prose, arrays as bullets, objects as bold-key bullets — recursively, never JSON. */
function renderValue(value: unknown, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [`${pad}${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "object" && item !== null) return renderValue(item, indent);
      return [`${pad}- ${String(item)}`];
    });
  }
  const lines: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      lines.push(`${pad}- **${titleCase(key)}:**`);
      lines.push(...renderValue(v, indent + 1));
    } else {
      lines.push(`${pad}- **${titleCase(key)}:** ${String(v)}`);
    }
  }
  return lines;
}

/** One-line enrichment summary for an IP — only the fields actually present. */
function summariseEnrichment(e: IpEnrichment): string {
  const parts: string[] = [];
  if (e.geoip) {
    const g = e.geoip;
    const loc = `${g.country ?? "??"}`;
    const asn = g.asn ? `AS${g.asn}${g.as_org ? ` ${g.as_org}` : ""}` : g.as_org ?? "";
    parts.push([loc, asn].filter((s) => s && s.length > 0).join(" · "));
  }
  if (e.greynoise) {
    const gn = e.greynoise;
    const flags = [gn.noise ? "noise" : null, gn.riot ? "RIOT" : null].filter(Boolean).join("/");
    parts.push(`GreyNoise: ${gn.classification ?? "unknown"}${flags ? ` (${flags})` : ""}`);
  }
  if (e.vt_verdict) {
    const vt = e.vt_verdict;
    const counts =
      typeof vt.malicious === "number" && typeof vt.total_vendors === "number"
        ? ` ${vt.malicious}/${vt.total_vendors}`
        : "";
    parts.push(`VirusTotal: ${vt.verdict ?? "unknown"}${counts}${vt.source === "stub" ? " (stub)" : ""}`);
  }
  return parts.filter((p) => p.length > 0).join(" · ") || "no enrichment data";
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { triage, ip_enrichment, approval, ips, ...payload } = input;
    if (triage === undefined || triage === null) {
      throw new Error("A_FORMAT_IP_ADVISORY: triage is required");
    }

    const enriched = parseAgentJson(triage);
    const gate = (approval ?? {}) as Partial<GateResult>;
    const date = new Date().toISOString().slice(0, 10);

    // TLP marking: consume A_TAG_TLP's output when present; GREEN default.
    const tlpInput = (input as { tlp?: { marking?: string } | string }).tlp;
    const tlp =
      typeof tlpInput === "string"
        ? tlpInput
        : typeof tlpInput?.marking === "string"
          ? tlpInput.marking
          : "TLP:GREEN";

    const verdict = typeof enriched.verdict === "string" ? enriched.verdict : undefined;
    const confidence = typeof enriched.confidence === "number" ? enriched.confidence : undefined;
    const advisoryText =
      typeof enriched.advisory === "string"
        ? enriched.advisory
        : typeof enriched.summary === "string"
          ? enriched.summary
          : undefined;
    // Whatever else the triage model returned (findings, recommended_actions, …)
    // becomes its own section — minus the fields rendered explicitly above.
    const { advisory: _a, summary: _s, verdict: _v, confidence: _c, ...extraSections } = enriched;

    const md: string[] = [
      `#### 🛡️ CommunitySOC Advisory — IP Investigation`,
      "",
      `\`${tlp}\` · ${date}${verdict ? ` · verdict: **${verdict}**` : ""}${typeof confidence === "number" ? ` (confidence ${Math.round(confidence * 100)}%)` : ""}`,
      "",
      advisoryText ?? "(no triage summary)",
    ];

    for (const [key, value] of Object.entries(extraSections)) {
      if (value === null || value === undefined) continue;
      md.push("", `**${titleCase(key)}**`, "");
      md.push(...(typeof value === "string" ? [value] : renderValue(value)));
    }

    const enrichmentList = Array.isArray(ip_enrichment) ? (ip_enrichment as IpEnrichment[]) : [];
    if (enrichmentList.length > 0) {
      md.push("", "**Per-IP enrichment**", "");
      for (const e of enrichmentList) {
        const ip = e.ip ?? e.geoip?.ip ?? "(unknown IP)";
        md.push(`- \`${ip}\` — ${summariseEnrichment(e)}`);
        if (e.owner && Object.keys(e.owner).length > 0) {
          md.push(...renderValue({ owner: e.owner }, 1));
        }
      }
    }

    const ipList = Array.isArray(ips) ? (ips as string[]) : [];
    if (ipList.length > 0) {
      md.push("", "**Indicators** (observed IPs)", "", ...ipList.map((i) => `- \`${i}\``));
    }

    if (gate.notes) md.push("", `**Analyst notes:** ${gate.notes}`);
    md.push(
      "",
      "---",
      `_Triaged by a local model · enriched on observed IPs · approved via gate \`${gate.name ?? "—"}\`${gate.closed_at ? ` at ${gate.closed_at}` : ""} · assembled by pulse_`,
    );

    const markdown = md.join("\n");
    const advisory_doc = {
      tlp,
      subject: `[CommunitySOC] IP Investigation Advisory (${date}, ${tlp})`,
      date,
      markdown,
      // Plain-text fallback for mailers without markdown rendering
      text: markdown.replace(/[*_`#>]/g, ""),
    };

    console.log(`📝 [A_FORMAT_IP_ADVISORY] rendered advisory (${markdown.length} chars) — subject: ${advisory_doc.subject}`);
    return { ...payload, triage, ip_enrichment, advisory_doc };
  },
};
