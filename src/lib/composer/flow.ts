import { parsePipeline } from "../pipeline";
import { compose, type ComposerLLM, type ComposeOptions } from "./compose";
import { choosesMailRecipient, deliveryFindings, deliveryGap, ONLY_OWN_ADDRESSES, readDeliveryAsk } from "./delivery";
import type { CatalogEntry, Finding } from "./validate-pipeline";
const noMatch = (message: string) => ({ status: "no-match", kind: "missing-capability", message }) as const;
export interface ComposeFlowOptions extends Omit<ComposeOptions, "check"> {
    catalog: CatalogEntry[];
    llm: ComposerLLM;
    holdToDelivery?: boolean;
}
const instructions = `You compose Pulse pipelines from a fixed installed action catalog.
Only use installed action names, never invent an action or silently omit a requested capability.
If a required capability is missing, respond: Closest I have is <installed action or none>; the gap is <missing capability>. Pivot to <alternative>?
Otherwise emit a fenced yaml document with name: F_UPPER_SNAKE and a nonempty actions: list.
Plain actions MUST be bare strings. Write "- ACTION_NAME # sovereignty: D, residency: CH", never "- ACTION_NAME:".
There are NO per-action parameter mappings. Every action reads named fields from one shared passthrough payload.
Do not write field references like ACTION_NAME.output; fields are simply the output keys themselves.
To provide required configuration such as a search query, place an agent step BEFORE the action with collect set to that field name.
Agent judgment steps use {agent: {name, capability, prompt, collect}}.
Collection adapters use {map: {over, as, collect, actions: [...]}}. Never use block:, with:, or input: wrappers.
Every top-level step needs a trailing YAML comment ON THE LIST ITEM LINE: # sovereignty: D|A|H, residency: CH|EU|frontier.
Agent steps are a built-in primitive, not actions needing installation. They can infer configuration fields from the request or assess upstream data.
Example of a correctly annotated judgment step:
name: F_EXAMPLE
actions:
  - agent: # sovereignty: A, residency: CH
      name: derive-criterion
      capability: compose.judgment
      prompt: "Infer the criterion from: {scenario}"
      collect: criterion
      sovereignty: { model_class: local-only, frontier_ok: false, data_residency: CH }
For map and gate primitives the annotation likewise follows the map: or gate: on the list-item line.
Never move the annotation onto a nested field; that does not annotate the step.
Connect required inputs by exact field names from earlier outputs or the initial fields listed below.
Use agent collect fields for judgments, never to simulate a missing external tool or side effect.
Emit an optional fenced mermaid diagram and a plain-language summary. Do not add schedules or execute anything.
Installed catalog:
`;
const deliveryRules = `When the request names a delivery, end the flow with an installed action whose tags say it sends on that channel (send, deliver, post or publish). A formatter does not send.
Never replace the requested channel with another. If nothing installed can send on it, use the Closest I have reply and offer the other channel there.
A mail action reaches only the principal's own addresses: leave its to field out and never collect it. If the request mails anyone else, use the Closest I have reply.
`;
export async function composeFlow(request: string, options: ComposeFlowOptions) {
    const initialFields = options.initialFields ?? ["scenario", "text"];
    try {
        if (!Number.isInteger(options.maxRetries ?? 2) || (options.maxRetries ?? 2) < 0 || (options.maxRetries ?? 2) > 2) throw new Error("maxRetries must be an integer between 0 and 2");
        const ask = options.holdToDelivery ? await readDeliveryAsk(request, options.llm) : null;
        const gap = ask ? deliveryGap(ask, options.catalog) : null;
        if (gap) return noMatch(gap);
        const result = await compose(request, options.catalog, options.llm, {
            ...options,
            initialFields,
            strictReply: options.strictReply ?? true,
            check: ask ? (yaml) => deliveryFindings(ask, yaml, options.catalog) : undefined,
            systemPrompt: options.systemPrompt ?? `${ask ? deliveryRules : ""}${instructions}${JSON.stringify(options.catalog)}\nInitial fields: ${JSON.stringify(initialFields)}`,
        });
        if (!result.ok) {
            if (result.kind === "no-match") {
                return noMatch(result.message);
            }
            const undelivered = result.findings.filter((finding) => finding.rule === "missing-delivery");
            if (undelivered.length > 0) {
                return noMatch(`I could not compose a routine that delivers as asked: ${undelivered.map((finding) => finding.message).join("; ")}.`);
            }
            const missing = result.findings.filter((finding) => finding.rule === "unknown-block");
            if (missing.length > 0) {
                return noMatch(missing.map((finding) => finding.message).join("; "));
            }
            return { status: "invalid", kind: "off-contract", findings: result.findings } as const;
        }
        if (ask && choosesMailRecipient(result.yaml, options.catalog)) {
            return noMatch(ONLY_OWN_ADDRESSES);
        }
        const flow = parsePipeline(result.yaml);
        return { status: "complete", flow, yaml: result.yaml, summary: result.summary, mermaid: result.mermaid } as const;
    }
    catch (error) {
        const findings: Finding[] = [{ rule: "parse-error", step: -1, message: error instanceof Error ? error.message : String(error) }];
        return { status: "invalid", kind: "composition-failed", findings } as const;
    }
}
export type ComposeFlowResult = Awaited<ReturnType<typeof composeFlow>>;
