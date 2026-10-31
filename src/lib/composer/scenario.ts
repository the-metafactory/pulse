import { parse as parseYaml } from "yaml";
import { runPipeline } from "../pipeline";
import { validateSteps } from "../step-runner";
import { createLocalCapabilities } from "../capabilities";
import type { GateProvider, ActionStepEvent } from "../../types/pipeline";
import { StdinGateProvider } from "../gate-provider";
import { buildCatalog } from "./catalog";
import { validatePipeline, type StepAnnotation } from "./validate-pipeline";
import { composeFlow } from "./flow";
import { loadSystemPrompt } from "./compose";
import { compose, SELF_DISCLOSURE, type ComposerLLM } from "./compose";
import { renderMermaid } from "./mermaid";
import { ConsolePoster, MMAckGateProvider, MattermostThread, mmConfigFromEnv, type ThreadPoster } from "./mm";
import type { AgentProvider, AgentTaskSpec, AgentTaskResult } from "../../types/agent";
export function makeLocalLlmAgentProvider(llm: ComposerLLM): AgentProvider {
    return {
        async dispatch(spec: AgentTaskSpec): Promise<AgentTaskResult> {
            const startedAt = Date.now();
            const taskId = crypto.randomUUID();
            const sov = spec.sovereignty;
            if (sov?.model_class === "local-only" || sov?.frontier_ok === false) {
                return {
                    task_id: taskId,
                    status: "failed",
                    output: null,
                    error: `refused: task '${spec.capability}' requires a local model ` +
                        `(model_class=${sov.model_class ?? "?"}, frontier_ok=${sov.frontier_ok ?? "?"}); ` +
                        `the demo local provider only has frontier access — route via the fleet (MyelinAgentProvider)`,
                    duration_ms: Date.now() - startedAt,
                };
            }
            try {
                const res = await llm(spec.prompt, {
                    system: "You are a SOC analyst agent executing one step of a security pipeline. " +
                        "Respond concisely with the requested assessment as plain text — no preamble.",
                    tier: "smart",
                });
                return {
                    task_id: taskId,
                    status: "completed",
                    output: (res.text ?? "").trim(),
                    duration_ms: Date.now() - startedAt,
                };
            }
            catch (err) {
                return {
                    task_id: taskId,
                    status: "failed",
                    output: null,
                    error: err instanceof Error ? err.message : String(err),
                    duration_ms: Date.now() - startedAt,
                };
            }
        },
    };
}
export interface OllamaProviderOpts {
    model?: string;
    url?: string;
    timeoutMs?: number;
}
export function makeOllamaAgentProvider(opts: OllamaProviderOpts = {}): AgentProvider {
    const model = opts.model ?? process.env.PULSE_LOCAL_MODEL ?? "llama3.2:latest";
    const url = (opts.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
    const envTimeout = Number(process.env.PULSE_LOCAL_TIMEOUT_MS);
    const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120000);
    return {
        async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
            const startedAt = Date.now();
            const taskId = crypto.randomUUID();
            dispatchOpts?.onDispatched?.({ task_id: taskId });
            const fail = (error: string): AgentTaskResult => ({
                task_id: taskId,
                status: "failed",
                output: null,
                error,
                duration_ms: Date.now() - startedAt,
            });
            if (dispatchOpts?.signal?.aborted)
                return fail(`ollama ${model}: task aborted before dispatch`);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            dispatchOpts?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
            try {
                const res = await fetch(`${url}/api/generate`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        model,
                        prompt: spec.prompt,
                        system: "You are a SOC analyst agent executing one step of a security pipeline. " +
                            "Respond concisely with the requested assessment as plain text — no preamble.",
                        stream: false,
                    }),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    return fail(`ollama ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
                }
                const body = (await res.json()) as {
                    response?: string;
                };
                return {
                    task_id: taskId,
                    status: "completed",
                    output: (body.response ?? "").trim(),
                    model,
                    duration_ms: Date.now() - startedAt,
                };
            }
            catch (err) {
                return fail(controller.signal.aborted && !dispatchOpts?.signal?.aborted
                    ? `ollama ${model}: timeout after ${timeoutMs}ms`
                    : err instanceof Error
                        ? err.message
                        : String(err));
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
export interface ApertusProviderOpts {
    apiToken: string;
    productId: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
}
export function makeApertusAgentProvider(opts: ApertusProviderOpts): AgentProvider {
    const model = opts.model ?? process.env.APERTUS_MODEL ?? "apertus";
    const base = (opts.baseUrl ?? "https://api.infomaniak.com").replace(/\/$/, "");
    const endpoint = `${base}/1/ai/${opts.productId}/openai/chat/completions`;
    const timeoutMs = opts.timeoutMs ?? 120000;
    return {
        async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
            const startedAt = Date.now();
            const taskId = crypto.randomUUID();
            dispatchOpts?.onDispatched?.({ task_id: taskId });
            const fail = (error: string): AgentTaskResult => ({
                task_id: taskId,
                status: "failed",
                output: null,
                error,
                duration_ms: Date.now() - startedAt,
            });
            if (dispatchOpts?.signal?.aborted)
                return fail(`apertus ${model}: task aborted before dispatch`);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            dispatchOpts?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
            try {
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${opts.apiToken}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            {
                                role: "system",
                                content: "You are a SOC analyst agent executing one step of a security pipeline. " +
                                    "Respond concisely with the requested assessment as plain text — no preamble.",
                            },
                            { role: "user", content: spec.prompt },
                        ],
                        stream: false,
                    }),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    return fail(`apertus ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
                }
                const body = (await res.json()) as {
                    choices?: {
                        message?: {
                            content?: string;
                        };
                    }[];
                    data?: {
                        choices?: {
                            message?: {
                                content?: string;
                            };
                        }[];
                    };
                };
                const choices = body.choices ?? body.data?.choices;
                const output = choices?.[0]?.message?.content;
                if (typeof output !== "string") {
                    return fail(`apertus ${model}: no choices[0].message.content in response`);
                }
                return {
                    task_id: taskId,
                    status: "completed",
                    output: output.trim(),
                    model,
                    duration_ms: Date.now() - startedAt,
                };
            }
            catch (err) {
                return fail(controller.signal.aborted && !dispatchOpts?.signal?.aborted
                    ? `apertus ${model}: timeout after ${timeoutMs}ms`
                    : err instanceof Error
                        ? err.message
                        : String(err));
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
export function makeApertusAgentProviderFromEnv(): AgentProvider | null {
    const apiToken = process.env.APERTUS_API_TOKEN ?? process.env.INFOMANIAK_API_TOKEN;
    const productId = process.env.APERTUS_PRODUCT_ID ?? process.env.INFOMANIAK_AI_PRODUCT_ID;
    if (!apiToken || !productId)
        return null;
    return makeApertusAgentProvider({
        apiToken,
        productId,
        ...(process.env.APERTUS_MODEL !== undefined && { model: process.env.APERTUS_MODEL }),
        ...(process.env.APERTUS_URL !== undefined && { baseUrl: process.env.APERTUS_URL }),
    });
}
export function makeSovereignAgentProvider(backends: {
    frontier: AgentProvider;
    local: AgentProvider;
}): AgentProvider {
    return {
        async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
            const sov = spec.sovereignty;
            const mustStayLocal = sov?.model_class === "local-only" || sov?.frontier_ok === false;
            const backend = mustStayLocal ? backends.local : backends.frontier;
            return backend.dispatch(spec, dispatchOpts);
        },
    };
}
export function resolveAgentProvider(llm: ComposerLLM): AgentProvider | undefined {
    const localEnabled = Boolean(process.env.PULSE_LOCAL_MODEL || process.env.OLLAMA_URL);
    const apertus = makeApertusAgentProviderFromEnv();
    if (!localEnabled && apertus === null)
        return undefined;
    return makeSovereignAgentProvider({
        frontier: apertus ?? makeLocalLlmAgentProvider(llm),
        local: localEnabled ? makeOllamaAgentProvider() : makeLocalLlmAgentProvider(llm),
    });
}
export function stepLine(event: ActionStepEvent, annotations: StepAnnotation[]): string | null {
    if (event.type === "step.started")
        return null;
    const annotation = annotations.find((a) => a.label === event.action);
    const cls = annotation?.sovereignty ? `\`${annotation.sovereignty}\`` : "`?`";
    const residency = annotation?.residency ? ` · ${annotation.residency}` : "";
    if (event.type === "step.failed") {
        return `❌ **${event.action}** ${cls}${residency} — failed after ${event.durationMs}ms: ${event.error.slice(0, 200)}`;
    }
    const fields = event.output_fields.length ? `→ ${event.output_fields.map((f) => `\`${f}\``).join(", ")}` : "→ (passthrough)";
    return `✅ **${event.action}** ${cls}${residency} — ${event.durationMs}ms ${fields}`;
}
export function makeStubLLM(): ComposerLLM {
    return async () => ({
        text: [
            "```yaml",
            "name: F_STUB_TRIAGE",
            "actions:",
            "  - A_EXTRACT_IOCS  # sovereignty: D, residency: CH",
            "  - A_TAG_TLP  # sovereignty: D, residency: CH",
            "```",
            "",
            "```mermaid",
            "flowchart TD",
            '  A["A_EXTRACT_IOCS (D)"] --> B["A_TAG_TLP (D)"]',
            "```",
            "",
            "Scenario text in, refanged IOCs and a TLP marking out; fully deterministic and local.",
        ].join("\n"),
    });
}
export interface RunScenarioOptions {
    blocksDir: string;
    llm: ComposerLLM;
    poster: ThreadPoster;
    gateProvider: GateProvider;
    agentProvider?: AgentProvider | null;
    initialInput?: Record<string, unknown>;
    render?: boolean;
}
export type RunScenarioResult = {
    status: "no-match";
    message: string;
} | {
    status: "invalid";
    findings: unknown[];
} | {
    status: "aborted";
    notes: string;
} | {
    status: "complete" | "failed";
    output?: Record<string, unknown>;
    error?: string;
    yaml?: string;
    name?: string;
};
function sanitizeFlowName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 64);
    return cleaned.length > 0 ? cleaned : "flow";
}
export function fenceSafe(s: string): string {
    return s.replace(/```/g, "`\u200b``");
}
export function channelSafe(s: string): string {
    return fenceSafe(s).replace(/@(everyone|here)/gi, "@\u200b$1");
}
interface ExecuteFlowArgs {
    opts: RunScenarioOptions;
    flow: {
        yaml: string;
        mermaid: string | null;
        summary: string;
    };
    catalog: Awaited<ReturnType<typeof buildCatalog>>;
    initialInput: Record<string, unknown>;
    blocksDir: string;
    leadPost?: string;
    autoApprove?: boolean;
}
async function executeValidatedFlow(args: ExecuteFlowArgs): Promise<RunScenarioResult> {
    const { opts, flow, catalog, initialInput, blocksDir, leadPost, autoApprove } = args;
    const validation = validatePipeline(flow.yaml, catalog, { initialFields: Object.keys(initialInput) });
    if (!validation.valid) {
        await opts.poster.post(`🛑 Validator refused the flow:\n${validation.findings.map((f) => `- ${f.message}`).join("\n")}`);
        return { status: "invalid", findings: validation.findings };
    }
    if (leadPost !== undefined)
        await opts.poster.post(leadPost);
    let doc: {
        name?: string;
        actions: unknown[];
    };
    try {
        doc = parseYaml(flow.yaml) as {
            name?: string;
            actions: unknown[];
        };
    }
    catch (err) {
        await opts.poster.post(`🛑 Validator refused the flow: unparseable YAML — ${err instanceof Error ? err.message : String(err)}`);
        return { status: "invalid", findings: [{ message: "unparseable YAML" }] };
    }
    const name = doc.name ?? "F_COMPOSED";
    if (!autoApprove) {
        const png = opts.render === false ? null : await renderMermaid(flow.mermaid ?? "");
        const diagramPart = png ? undefined : flow.mermaid ? `\n\`\`\`mermaid\n${fenceSafe(flow.mermaid)}\`\`\`` : "";
        await opts.poster.post(`**${channelSafe(flow.summary)}**\n\`\`\`yaml\n${fenceSafe(flow.yaml)}\`\`\`${diagramPart ?? ""}`, png ? { bytes: png, filename: "flow.png" } : undefined);
        const ack = await opts.gateProvider.requestVerdict({ name: "operator-ack", prompt: "Run this flow?" });
        if (ack.verdict !== "pass") {
            await opts.poster.post(`🛑 Aborted by operator: ${ack.notes}`);
            return { status: "aborted", notes: ack.notes };
        }
    }
    const steps = validateSteps(doc.actions);
    const agentProvider = opts.agentProvider === undefined ? makeLocalLlmAgentProvider(opts.llm) : opts.agentProvider;
    const result = await runPipeline({ name, actions: steps }, initialInput, {
        actionDirs: [blocksDir],
        gateProvider: opts.gateProvider,
        ...(agentProvider !== null && { agentProvider }),
        onActionStepEvent: (event) => {
            const line = stepLine(event, validation.annotations);
            if (line)
                void opts.poster.post(line);
        },
    });
    if (result.success) {
        const advisory = (result.output as {
            advisory_doc?: {
                subject?: string;
                markdown?: string;
            };
        } | undefined)?.advisory_doc;
        const finalMessage = advisory?.markdown
            ? `🏁 **Final artifact** — ${advisory.subject ?? "advisory"}\n\n${advisory.markdown}`
            : `🏁 **Flow complete** (${result.durationMs}ms) — output fields: ${Object.keys(result.output ?? {}).map((k) => `\`${k}\``).join(", ")}`;
        await opts.poster.post(finalMessage);
        return { status: "complete", output: result.output, yaml: flow.yaml, name };
    }
    await opts.poster.post(`❌ Flow failed: ${result.error}`);
    return { status: "failed", error: result.error, yaml: flow.yaml, name };
}
export async function runScenario(scenario: string, opts: RunScenarioOptions): Promise<RunScenarioResult> {
    const blocksDir = opts.blocksDir;
    const catalog = await buildCatalog(blocksDir);
    const initialInput = opts.initialInput ?? { scenario, text: scenario };
    await opts.poster.post(SELF_DISCLOSURE);
    const composed = await compose(scenario, catalog, opts.llm, {
        initialFields: Object.keys(initialInput),
    });
    if (!composed.ok) {
        if (composed.kind === "no-match") {
            await opts.poster.post(`🤷 ${composed.message}`);
            return { status: "no-match", message: composed.message };
        }
        await opts.poster.post(`🛑 Could not produce a valid flow after ${composed.attempts} attempts:\n${composed.findings.map((f) => `- ${f.message}`).join("\n")}`);
        return { status: "invalid", findings: composed.findings };
    }
    return executeValidatedFlow({
        opts,
        flow: { yaml: composed.yaml, mermaid: composed.mermaid, summary: `Composed flow — ${composed.summary}` },
        catalog,
        initialInput,
        blocksDir,
    });
}
export async function composeScenario(scenario: string, opts: {
    llm: ComposerLLM;
    blocksDir: string;
    initialFields?: string[];
}): Promise<{
    status: "complete";
    yaml: string;
    summary: string;
    mermaid: string | null;
} | {
    status: "no-match";
    message: string;
} | {
    status: "invalid";
    findings: {
        message: string;
    }[];
}> {
    const blocksDir = opts.blocksDir;
    const catalog = await buildCatalog(blocksDir);
    return composeFlow(scenario, {
        catalog,
        llm: opts.llm,
        initialFields: opts.initialFields ?? ["scenario", "text"],
        strictReply: false,
        systemPrompt: await loadSystemPrompt(catalog),
    });
}
export async function runSavedFlow(yaml: string, opts: RunScenarioOptions): Promise<RunScenarioResult> {
    const blocksDir = opts.blocksDir;
    const catalog = await buildCatalog(blocksDir);
    const initialInput = opts.initialInput ?? { scenario: "", text: "" };
    const rawName = ((): string => {
        try {
            return (parseYaml(yaml) as {
                name?: string;
            }).name ?? "saved flow";
        }
        catch (_err) {
            return "saved flow";
        }
    })();
    const name = sanitizeFlowName(rawName);
    return executeValidatedFlow({
        opts,
        flow: { yaml, mermaid: null, summary: `Saved flow — ${name}` },
        catalog,
        initialInput,
        blocksDir,
        leadPost: `▶️ Running saved flow **${name}** (no re-composition, no re-ack).`,
        autoApprove: true,
    });
}
