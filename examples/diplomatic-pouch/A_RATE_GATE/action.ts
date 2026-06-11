/**
 * A_RATE_GATE — Foreign Policy §4 via the RATE-GATE.md blueprint (built from
 * spec). check() is pure and never mutates; the ledger only grows in
 * A_SEAL_POUCH after the human approved AND the send happened. `now` arrives
 * in the payload — the guard never reads the wall clock.
 */
import type { ActionContext } from "../../../src/types/action";
import { check } from "../lib/rate-gate";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, note_sha256, thread, now, ...payload } = input;
    const readFile = ctx.capabilities.readFile;
    if (!readFile) throw new Error("A_RATE_GATE requires readFile");

    let ledger: unknown = [];
    try {
      ledger = JSON.parse(await readFile(`${pouch_dir}/ledger.json`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such file|ENOENT/i.test(msg)) {
        // Present but unreadable/unparseable → the guard fails closed.
        ledger = null;
      }
      // Absent ledger: fresh pouch, empty ledger — first contact path.
    }

    const decision = check(ledger, String(note_sha256), String(thread), String(now));
    if (!decision.allowed) {
      throw new Error(`A_RATE_GATE: blocked — ${decision.reason}`);
    }
    console.log(`📮 rate gate: ${decision.reason}`);
    return { ...payload, pouch_dir, note_sha256, thread, now, rate_decision: decision };
  },
};
