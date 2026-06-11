/**
 * A_CHANNEL_CHECK — the channel's resting state gates everything. A halted
 * channel (a prior tripwire) refuses BOTH directions until a human reopens it
 * by editing pouch/channel-state.json — reopening is outside the agent loop.
 * Absent state file = open (fresh pouch); unreadable state = halted (fail closed).
 *
 * Note: this is the agent-visible TRIPWIRE state. The kill switch proper
 * (Foreign Policy §9) sits ABOVE it — a human revoking outbox write access —
 * and is deliberately NOT a flag this code reads.
 */
import type { ActionContext } from "../../../src/types/action";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, ...payload } = input;
    const readFile = ctx.capabilities.readFile;
    if (!readFile) throw new Error("A_CHANNEL_CHECK requires readFile");

    let channel: { status: string; reason?: string } = { status: "open" };
    try {
      const raw = await readFile(`${pouch_dir}/channel-state.json`);
      const parsed = JSON.parse(raw) as { status?: unknown; reason?: unknown };
      channel = {
        status: typeof parsed.status === "string" ? parsed.status : "halted",
        reason: typeof parsed.reason === "string" ? parsed.reason : "state file malformed — failing closed",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such file|ENOENT/i.test(msg)) {
        throw new Error(`A_CHANNEL_CHECK: channel state unreadable — failing closed (${msg})`);
      }
      // Absent file: a fresh pouch is open. (Default resting state for the
      // SEND decision is still closed — the human gate downstream is the green.)
    }

    if (channel.status !== "open") {
      throw new Error(`A_CHANNEL_CHECK: channel is ${channel.status} — ${channel.reason ?? "see alarms"}. A human must review pouch/alarms and reopen channel-state.json.`);
    }
    return { ...payload, pouch_dir, channel };
  },
};
