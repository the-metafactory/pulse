/**
 * A_TRIPWIRE — Foreign Policy §9: an inbound message that attempts to rewrite
 * the Diplomat's rules does not merely get stripped — it HALTS THE CHANNEL
 * and alerts the human. Runs BEFORE stripping so the alarm carries the
 * evidence as received. Reopening the channel is a human file edit, outside
 * this pipeline's reach.
 */
import type { ActionContext } from "../../../src/types/action";
import { scanInbound } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, inbound_text, inbound_name, now, ...payload } = input;
    const writeFile = ctx.capabilities.writeFile;
    if (!writeFile) throw new Error("A_TRIPWIRE requires writeFile");

    const scan = scanInbound(String(inbound_text));
    if (scan.tripwire.length > 0) {
      const alarm = {
        ts: String(now),
        inbound: String(inbound_name),
        attempts: scan.tripwire,
        evidence: String(inbound_text),
        action: "channel HALTED — a human must review this alarm and decide whether to reopen (and whether to tell the peer)",
      };
      await writeFile(`${pouch_dir}/alarms/${String(now).replace(/[:.]/g, "-")}-${String(inbound_name)}.json`, JSON.stringify(alarm, null, 2) + "\n");
      await writeFile(`${pouch_dir}/channel-state.json`, JSON.stringify({ status: "halted", reason: `tripwire: rule-rewrite attempt in '${String(inbound_name)}' (${scan.tripwire.map((t) => t.pattern).join(", ")})`, ts: String(now) }, null, 2) + "\n");
      throw new Error(`A_TRIPWIRE: rule-rewrite attempt detected (${scan.tripwire.map((t) => t.pattern).join(", ")}) — channel HALTED, alarm written. The attempt is itself the alarm.`);
    }
    return { ...payload, pouch_dir, inbound_text, inbound_name, now, tripwire: { tripped: false } };
  },
};
