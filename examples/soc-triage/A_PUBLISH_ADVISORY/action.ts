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

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { enrichment, approval, ...payload } = input;
    const result = enrichment as AgentTaskResult;
    const gate = approval as GateResult;
    const out = (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as EnrichmentOutput;

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
