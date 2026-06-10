/**
 * A_RECORD_AUDIT — append-only audit trail. Every containment decision lands
 * in out/audit.jsonl with the complete tribunal verdict: who voted what with
 * what confidence, every abstain cause, the diversity record, the tiebreak.
 *
 * On a live bus the same record already exists as envelope traffic (the free
 * Sága); this artifact is the local, durable view of it. "Every blocked
 * action, every verdict, who approved, when."
 */

import type { ActionContext } from "../../../src/types/action";
import type { TribunalVerdict } from "../../../src/types/tribunal";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { request_id, tribunal_containment, containment, ...payload } = input;
    const verdict = tribunal_containment as TribunalVerdict;
    const { readFile, writeFile } = ctx.capabilities;
    if (!readFile || !writeFile) {
      throw new Error("A_RECORD_AUDIT requires readFile + writeFile capabilities");
    }

    const audit_record = {
      ts: new Date().toISOString(),
      request_id,
      ruling: verdict.verdict,
      reason: verdict.reason,
      votes: verdict.votes.map((v) => ({
        seat: v.seat,
        verdict: v.verdict,
        confidence: v.confidence,
        model: v.model,
        abstain_cause: v.abstain_cause,
      })),
      tiebreak: verdict.tiebreak
        ? { seat: verdict.tiebreak.seat, verdict: verdict.tiebreak.verdict, model: verdict.tiebreak.model }
        : null,
      diversity: verdict.diversity,
      containment_applied: Boolean(containment),
    };

    const outPath = new URL("../out/audit.jsonl", import.meta.url).pathname;
    let existing = "";
    try {
      existing = await readFile(outPath);
    } catch (_err) {
      // first run — audit log doesn't exist yet, start it
    }
    await writeFile(outPath, existing + JSON.stringify(audit_record) + "\n");

    console.log(`🧾 audit record appended → ${outPath}`);

    return { ...payload, request_id, tribunal_containment, containment, audit_record };
  },
};
