/**
 * A_PREPARE_NOTE — intake for an outbound note. The note is a document a
 * human already wrote (clerk, not mirror — Foreign Policy §6): this action
 * never composes content, it loads + fingerprints it. Border 1 at the source:
 * only .md/.json/.txt may even be prepared.
 */
import type { ActionContext } from "../../../src/types/action";
import { extensionAllowed, sha256Hex } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { note_path, ...payload } = input;
    const readFile = ctx.capabilities.readFile;
    if (!readFile) throw new Error("A_PREPARE_NOTE requires readFile");

    const path = String(note_path);
    if (!extensionAllowed(path)) {
      throw new Error(`A_PREPARE_NOTE: border 1 — only .md/.json/.txt cross the pouch (got ${path})`);
    }
    const note_text = await readFile(path);
    const note_sha256 = await sha256Hex(note_text);
    return { ...payload, note_path: path, note_text, note_sha256 };
  },
};
