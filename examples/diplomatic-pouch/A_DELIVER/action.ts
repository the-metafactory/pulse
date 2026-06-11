/**
 * A_DELIVER — only after a human promoted it (the gate) does the wrapped note
 * leave quarantine for pouch/read/. The Diplomat carried; the human decided.
 */
import type { ActionContext } from "../../../src/types/action";
import type { GateResult } from "../../../src/types/pipeline";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, wrapped_text, inbound_name, promotion, ...payload } = input;
    const writeFile = ctx.capabilities.writeFile;
    if (!writeFile) throw new Error("A_DELIVER requires writeFile");
    const gate = promotion as GateResult;
    const name = String(inbound_name);
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new Error(`A_DELIVER: refusing '${name}' — path separators / traversal in an inbound name`);
    }
    const target = `${pouch_dir}/read/${name}`;
    await writeFile(target, String(wrapped_text));
    console.log(`\n📬 delivered to ${target} (promoted by: ${gate.notes || "(unnamed)"})`);
    return { ...payload, delivered: { path: target, promoted_by: gate.notes } };
  },
};
