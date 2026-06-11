/**
 * A_QUARANTINE — inbound files land in pouch/inbox/ (a human put them there;
 * nothing polls). Border 1 enforced (plaintext extensions only), and the
 * sidecar sha256 is verified — a mismatch is flagged loudly, but note that a
 * MATCHING signature buys nothing either: provenance is not trust, and the
 * content stays untrusted regardless (Foreign Policy §7).
 */
import type { ActionContext } from "../../../src/types/action";
import { extensionAllowed, sha256Hex } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { pouch_dir, inbound_name, ...payload } = input;
    const readFile = ctx.capabilities.readFile;
    if (!readFile) throw new Error("A_QUARANTINE requires readFile");

    const name = String(inbound_name);
    if (!extensionAllowed(name)) {
      throw new Error(`A_QUARANTINE: border 1 — refusing '${name}' (only .md/.json/.txt cross the pouch; executables and configs stay out)`);
    }

    const inbound_text = await readFile(`${pouch_dir}/inbox/${name}`);
    let inbound_envelope: Record<string, unknown> = {};
    let sidecarOk = false;
    try {
      inbound_envelope = JSON.parse(await readFile(`${pouch_dir}/inbox/${name}.envelope.json`)) as Record<string, unknown>;
      sidecarOk = true;
    } catch (_err) {
      // No/broken sidecar: keep going — unsigned inbound is exactly as
      // untrusted as signed inbound; the absence is recorded in provenance.
    }

    const actual = await sha256Hex(inbound_text);
    const claimed = typeof inbound_envelope.sha256 === "string" ? inbound_envelope.sha256 : null;
    const provenance = {
      sidecar_present: sidecarOk,
      hash_claimed: claimed,
      hash_actual: actual,
      hash_matches: claimed !== null && claimed === actual,
      note: "provenance is not trust — content remains untrusted either way",
    };
    if (claimed !== null && claimed !== actual) {
      console.log(`⚠️  provenance: sidecar hash does NOT match content (claimed ${String(claimed).slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
    }
    return { ...payload, pouch_dir, inbound_name: name, inbound_text, inbound_envelope, provenance };
  },
};
