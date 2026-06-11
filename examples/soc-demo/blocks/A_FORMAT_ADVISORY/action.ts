/**
 * A_FORMAT_ADVISORY — one well-formed advisory document for every channel.
 *
 * Takes the structured pipeline outputs (triage, enrichment, sanitized IOCs,
 * gate verdict) and renders a single markdown document plus subject line.
 * Downstream publishers consume the document as-is: stdout, Mattermost
 * (markdown native), and mail (the KAI email CLI renders markdown to HTML).
 *
 * The renderer is shape-tolerant: models return strings, objects, or arrays
 * for any field — everything becomes readable prose/bullets, never raw JSON.
 */

import type { ActionContext } from "../../../../src/types/action";
import type { AgentTaskResult } from "../../../../src/types/agent";
import type { GateResult } from "../../../../src/types/pipeline";

interface SanitizedIocs {
  verdict?: string;
  confidence?: number;
  urls?: string[];
  domains?: string[];
  senders?: string[];
  hashes?: string[];
}

/** Parse agent output: object as-is; JSON string parsed (edge fences stripped); a ```json block embedded in prose extracted; prose kept raw. */
function parseAgentJson(output: unknown): Record<string, unknown> {
  if (typeof output !== "string") return (output ?? {}) as Record<string, unknown>;
  const cleaned = output.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (_err) {
    const embedded = output.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    if (embedded) {
      try {
        return JSON.parse(embedded[1]) as Record<string, unknown>;
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

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { triage, enrichment, iocs_sanitized, approval, ...payload } = input;
    const enriched = parseAgentJson((enrichment as AgentTaskResult).output);
    const gate = approval as GateResult;
    const iocs = (iocs_sanitized ?? {}) as SanitizedIocs;
    const date = new Date().toISOString().slice(0, 10);

    const advisoryText = typeof enriched.advisory === "string" ? enriched.advisory : undefined;
    const { advisory: _a, enrichment: enrichmentDetail, ...extraSections } = enriched;

    const md: string[] = [
      `#### 🛡️ CommunitySOC Advisory — Phishing Campaign`,
      "",
      `\`TLP:GREEN\` · ${date}${iocs.verdict ? ` · verdict: **${iocs.verdict}**` : ""}${typeof iocs.confidence === "number" ? ` (confidence ${Math.round(iocs.confidence * 100)}%)` : ""}`,
      "",
      advisoryText ?? "(no advisory text)",
    ];

    if (enrichmentDetail !== undefined && enrichmentDetail !== null) {
      md.push("", "**Threat intelligence**", "");
      md.push(...(typeof enrichmentDetail === "string" ? [enrichmentDetail] : renderValue(enrichmentDetail)));
    }

    // Any other top-level sections the model offered (recommendations, ttps, …)
    for (const [key, value] of Object.entries(extraSections)) {
      if (value === null || value === undefined) continue;
      md.push("", `**${titleCase(key)}**`, "");
      md.push(...(typeof value === "string" ? [value] : renderValue(value)));
    }

    const iocLines: string[] = [];
    if (iocs.urls?.length) iocLines.push(`- **URLs:**`, ...iocs.urls.map((u) => `  - \`${u}\``));
    if (iocs.domains?.length) iocLines.push(`- **Domains:**`, ...iocs.domains.map((d) => `  - \`${d}\``));
    if (iocs.senders?.length) iocLines.push(`- **Senders:**`, ...iocs.senders.map((s) => `  - \`${s}\``));
    if (iocs.hashes?.length) iocLines.push(`- **Hashes:**`, ...iocs.hashes.map((h) => `  - \`${h}\``));
    if (iocLines.length) {
      md.push("", "**Indicators of compromise** (sanitized — no member data)", "", ...iocLines);
    }

    if (gate.notes) md.push("", `**Analyst notes:** ${gate.notes}`);
    md.push(
      "",
      "---",
      `_Triaged by a local model · enriched by a frontier model on sanitized IOCs · approved via gate \`${gate.name}\`${gate.closed_at ? ` at ${gate.closed_at}` : ""} · assembled by pulse P_PHISH_TRIAGE_`,
    );

    const markdown = md.join("\n");
    const advisory_doc = {
      subject: `[CommunitySOC] Advisory — Phishing Campaign (${date}, TLP:GREEN)`,
      date,
      markdown,
      // Plain-text fallback for mailers without markdown rendering
      text: markdown.replace(/[*_`#>]/g, ""),
    };

    console.log(`📝 [A_FORMAT_ADVISORY] rendered advisory (${markdown.length} chars) — subject: ${advisory_doc.subject}`);
    return { ...payload, triage, enrichment, iocs_sanitized, approval, advisory_doc };
  },
};
