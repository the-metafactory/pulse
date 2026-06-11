/**
 * A_WRAP_UNTRUSTED — everything that crossed the pouch is read ABOUT as
 * untrusted external data. The wrapper is the standing reminder that no
 * downstream consumer may place this text in a prompt or instruction slot.
 */
import type { ActionContext } from "../../../src/types/action";
import { wrapUntrusted } from "../lib/borders";

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { stripped_text, inbound_envelope, ...payload } = input;
    const env = inbound_envelope as Record<string, unknown>;
    const wrapped_text = wrapUntrusted(
      String(stripped_text),
      typeof env.from === "string" ? env.from : "(unsigned)",
      typeof env.thread === "string" ? env.thread : "(no thread)",
    );
    return { ...payload, inbound_envelope, wrapped_text };
  },
};
