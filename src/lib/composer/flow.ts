import { parsePipeline } from "../pipeline";
import { compose, type ComposerLLM, type ComposeOptions } from "./compose";
import type { CatalogEntry, Finding } from "./validate-pipeline";
export interface ComposeFlowOptions extends ComposeOptions {
    catalog: CatalogEntry[];
    llm: ComposerLLM;
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
export async function composeFlow(request: string, options: ComposeFlowOptions) {
    const initialFields = options.initialFields ?? ["scenario", "text"];
    try {
        if (!Number.isInteger(options.maxRetries ?? 2) || (options.maxRetries ?? 2) < 0 || (options.maxRetries ?? 2) > 2) throw new Error("maxRetries must be an integer between 0 and 2");
        const result = await compose(request, options.catalog, options.llm, {
            ...options,
            initialFields,
            strictReply: options.strictReply ?? true,
            systemPrompt: options.systemPrompt ?? `${instructions}${JSON.stringify(options.catalog)}\nInitial fields: ${JSON.stringify(initialFields)}`,
        });
        if (!result.ok) {
            if (result.kind === "no-match") {
                return { status: "no-match", kind: "missing-capability", message: result.message } as const;
            }
            const missing = result.findings.filter((finding) => finding.rule === "unknown-block");
            if (missing.length > 0) {
                return { status: "no-match", kind: "missing-capability", message: missing.map((finding) => finding.message).join("; ") } as const;
            }
            return { status: "invalid", kind: "off-contract", findings: result.findings } as const;
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
