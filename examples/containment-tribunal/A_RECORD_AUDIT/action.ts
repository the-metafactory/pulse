/**
 * A_RECORD_AUDIT — append-only audit trail. Every containment decision lands
 * in out/audit.jsonl with the complete governed-action result: the L0 policy
 * decision, who voted what with what confidence, every abstain cause, the
 * diversity record, the tiebreak, the analyst's gate verdict.
 *
 * On a live bus the same record already exists as envelope traffic (the free
 * Sága); this artifact is the local, durable view of it. "Every blocked
 * action, every verdict, who approved, when."
 */

import type { ActionContext } from "../../../src/types/action";
import type { GovernedResult } from "../../../src/types/governed";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { request_id, governed_containment, containment, ...payload } = input;
    const ruling = governed_containment as GovernedResult;
    const { readFile, writeFile } = ctx.capabilities;
    if (!readFile || !writeFile) {
      throw new Error("A_RECORD_AUDIT requires readFile + writeFile capabilities");
    }

    const audit_record = {
      ts: new Date().toISOString(),
      request_id,
      outcome: ruling.outcome,
      resolved_by: ruling.resolved_by,
      l0: ruling.l0,
      tribunal: ruling.tribunal
        ? {
            verdict: ruling.tribunal.verdict,
            reason: ruling.tribunal.reason,
            votes: ruling.tribunal.votes.map((v) => ({
              seat: v.seat,
              verdict: v.verdict,
              confidence: v.confidence,
              model: v.model,
              abstain_cause: v.abstain_cause,
            })),
            tiebreak: ruling.tribunal.tiebreak
              ? { seat: ruling.tribunal.tiebreak.seat, verdict: ruling.tribunal.tiebreak.verdict }
              : null,
            diversity: ruling.tribunal.diversity,
          }
        : null,
      gate: ruling.gate ? { verdict: ruling.gate.verdict, notes: ruling.gate.notes } : null,
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

    return { ...payload, request_id, governed_containment, containment, audit_record };
  },
};
