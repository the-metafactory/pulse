/**
 * A_STRIP_INJECTION — border 2: instruction-like phrasing is stripped and
 * flagged (it cannot reach an instruction slot downstream because the wrap
 * step frames everything as data — this strip is belt, the wrap is braces).
 */
import type { ActionContext } from "../../../src/types/action";
import { scanInbound } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { inbound_text, ...payload } = input;
    const scan = scanInbound(String(inbound_text));
    if (scan.flagged.length > 0) {
      console.log(`🚩 injection phrasing stripped: ${scan.flagged.map((f) => f.pattern).join(", ")}`);
    }
    return { ...payload, stripped_text: scan.stripped, injection_flags: { flagged: scan.flagged } };
  },
};
