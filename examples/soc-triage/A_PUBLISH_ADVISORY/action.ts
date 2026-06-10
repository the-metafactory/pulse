/**
 * A_PUBLISH_ADVISORY — final deterministic step. In production this would
 * post to the member portal / mailing list; the demo renders to stdout.
 */

import type { ActionContext } from "../../../src/types/action";
import type { AgentTaskResult } from "../../../src/types/agent";
import type { GateResult } from "../../../src/types/pipeline";

interface EnrichmentOutput {
  enrichment?: string;
  advisory?: string;
}

/**
 * Parse agent output: object as-is; JSON string parsed (edge fences stripped);
 * a ```json block embedded in surrounding prose is extracted (real models
 * often preface the JSON with commentary); pure prose becomes the advisory body.
 */
function parseEnrichment(output: unknown): EnrichmentOutput {
  if (typeof output !== "string") return normalize((output ?? {}) as Record<string, unknown>);
  const cleaned = output.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return normalize(JSON.parse(cleaned) as Record<string, unknown>);
  } catch (_err) {
    const embedded = output.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    if (embedded) {
      try {
        return normalize(JSON.parse(embedded[1]) as Record<string, unknown>);
      } catch (_err2) {
        // fenced block wasn't valid JSON either — fall through to prose
      }
    }
    // model returned prose instead of JSON — publish it verbatim rather than failing the pipeline
    return { advisory: cleaned };
  }
}

/** Models sometimes return structured objects for these fields — render them readable, never "[object Object]" or raw JSON walls. */
function normalize(out: Record<string, unknown>): EnrichmentOutput {
  const asText = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") return v;
    return JSON.stringify(v, null, 2);
  };
  return { advisory: asText(out.advisory), enrichment: asText(out.enrichment) };
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { enrichment, approval, ...payload } = input;
    const result = enrichment as AgentTaskResult;
    const gate = approval as GateResult;
    const out = parseEnrichment(result.output);

    const advisory = {
      title: "CommunitySOC Advisory — Phishing Campaign",
      body: out.advisory ?? "(no advisory text)",
      enrichment: out.enrichment,
      approved_by_gate: gate.name,
      approved_at: gate.closed_at,
      analyst_notes: gate.notes,
    };

    console.log("\n" + "═".repeat(64));
    console.log("📢 PUBLISHED COMMUNITY ADVISORY");
    console.log("═".repeat(64));
    console.log(advisory.body);
    if (advisory.analyst_notes) console.log(`\nAnalyst notes: ${advisory.analyst_notes}`);
    console.log("═".repeat(64) + "\n");

    return { ...payload, enrichment, approval, published: advisory };
  },
};
