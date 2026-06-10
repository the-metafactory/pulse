/**
 * A_EXECUTE_CONTAINMENT — the consequential step. In production this would
 * push to the resolver/RPZ or firewall API; the demo writes the blocklist
 * artifact to out/blocklist.json.
 *
 * This action only runs when the tribunal ruled `allow` — a deny or defer
 * raises StepFailure upstream and the pipeline never reaches this point.
 * That ordering IS the governance property the example demonstrates.
 */

import type { ActionContext } from "../../../src/types/action";
import type { TribunalVerdict } from "../../../src/types/tribunal";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { targets, ttl_hours, tribunal_containment, ...payload } = input;
    const verdict = tribunal_containment as TribunalVerdict;
    const writeFile = ctx.capabilities.writeFile;
    if (!writeFile) {
      throw new Error("A_EXECUTE_CONTAINMENT requires the writeFile capability");
    }

    const blocklist = {
      applied_at: new Date().toISOString(),
      ttl_hours,
      entries: (targets as string[]).map((domain) => ({
        domain,
        action: "rpz-block",
        authorized_by: `tribunal:${verdict.name}`,
        ruling: verdict.verdict,
      })),
    };

    const outPath = new URL("../out/blocklist.json", import.meta.url).pathname;
    await writeFile(outPath, JSON.stringify(blocklist, null, 2) + "\n");

    console.log(`\n🔒 containment applied: ${blocklist.entries.length} domains → ${outPath}`);

    return { ...payload, targets, ttl_hours, tribunal_containment, containment: blocklist };
  },
};
