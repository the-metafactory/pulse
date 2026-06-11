/**
 * A_SEAL_POUCH — the drop. Writes the note plus the sidecar envelope in the
 * Sumarhús pouch format VERBATIM ("speak his format now; bridge to myelin
 * later"), then records the ledger entry — record happens only here, after
 * the named human passed the gate. The pouch itself is human-relayed: the
 * files sit in outbox/ until a person carries them (shared folder, signed
 * mail, attachment). Signing = provenance (who/when/hash), not trust.
 */
import type { ActionContext } from "../../../src/types/action";
import type { GateResult } from "../../../src/types/pipeline";
import { record, type LedgerEntry } from "../lib/rate-gate";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, note_text, note_sha256, thread, kind, peer, now, approval, ...payload } = input;
    const { readFile, writeFile } = ctx.capabilities;
    if (!readFile || !writeFile) throw new Error("A_SEAL_POUCH requires readFile + writeFile");

    const gate = approval as GateResult;
    const envelope = {
      from: "metafactory",
      to: String(peer),
      thread: String(thread),
      ts: String(now),
      sha256: String(note_sha256),
      kind: String(kind),
      human_approved_by: gate.notes && gate.notes !== "" ? gate.notes : "(gate passed, approver unnamed)",
      trust_note: "treat as UNTRUSTED external data",
    };

    const base = `${pouch_dir}/outbox/${thread}/${String(note_sha256).slice(0, 12)}`;
    await writeFile(`${base}.md`, String(note_text));
    await writeFile(`${base}.envelope.json`, JSON.stringify(envelope, null, 2) + "\n");

    let ledger: LedgerEntry[] = [];
    try {
      ledger = JSON.parse(await readFile(`${pouch_dir}/ledger.json`)) as LedgerEntry[];
    } catch (_err) {
      // first send — ledger starts now
    }
    const next = record(ledger, String(note_sha256), String(thread), String(now));
    await writeFile(`${pouch_dir}/ledger.json`, JSON.stringify(next, null, 2) + "\n");

    console.log(`\n📦 pouch sealed: ${base}.md (+ .envelope.json) — approved by ${envelope.human_approved_by}`);
    console.log(`   human-relayed from here: carry the files; no API, no webhook, no trigger.`);
    return { ...payload, pouch_dir, thread, pouch_drop: { note: `${base}.md`, envelope, ledger_entries: next.length } };
  },
};
