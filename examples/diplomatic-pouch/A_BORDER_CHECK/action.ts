/**
 * A_BORDER_CHECK — border 3: outbound is whitelisted, default is redact.
 * Implemented as BLOCK-don't-redact: any finding halts the pipeline and is
 * named, so the human fixes the SOURCE document. Silent redaction could leak
 * by omission error and hides policy violations from the human.
 */
import type { ActionContext } from "../../../src/types/action";
import { scanOutbound } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { note_text, ...payload } = input;
    const findings = scanOutbound(String(note_text));
    if (findings.length > 0) {
      const list = findings.map((f) => `${f.pattern} ("${f.match}…")`).join("; ");
      throw new Error(`A_BORDER_CHECK: ${findings.length} finding(s) — the note does not leave: ${list}. Remove the material from the source and re-run.`);
    }
    return { ...payload, note_text, border_scan: { findings: [], clean: true } };
  },
};
