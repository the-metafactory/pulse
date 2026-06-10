/**
 * A_PUBLISH_ADVISORY — final deterministic publish step. In production this
 * would post to the member portal / mailing list; the demo renders to stdout.
 *
 * Consumes the advisory document produced by A_FORMAT_ADVISORY — formatting
 * lives there (one renderer for stdout, Mattermost, and mail), publishing
 * lives here.
 */

import type { ActionContext } from "../../../src/types/action";
import type { GateResult } from "../../../src/types/pipeline";

interface AdvisoryDoc {
  subject?: string;
  date?: string;
  markdown?: string;
  text?: string;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { advisory_doc, approval, ...payload } = input;
    const doc = (advisory_doc ?? {}) as AdvisoryDoc;
    const gate = approval as GateResult;

    const published = {
      subject: doc.subject ?? "CommunitySOC Advisory",
      body: doc.markdown ?? "(no advisory document)",
      approved_by_gate: gate.name,
      approved_at: gate.closed_at,
      analyst_notes: gate.notes,
    };

    console.log("\n" + "═".repeat(64));
    console.log("📢 PUBLISHED COMMUNITY ADVISORY");
    console.log("═".repeat(64));
    console.log(published.body);
    console.log("═".repeat(64) + "\n");

    return { ...payload, advisory_doc, approval, published };
  },
};
