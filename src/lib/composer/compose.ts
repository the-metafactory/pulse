import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMOptions, LLMResponse } from "../../types/action";
import { validatePipeline, type CatalogEntry, type Finding, type StepAnnotation, } from "./validate-pipeline";
export type ComposerLLM = (prompt: string, options?: LLMOptions) => Promise<LLMResponse>;
export interface ComposeOptions {
    initialFields?: string[];
    strictReply?: boolean;
    maxRetries?: number;
    systemPrompt?: string;
}
export type ComposeResult = {
    ok: true;
    yaml: string;
    mermaid: string | null;
    summary: string;
    annotations: StepAnnotation[];
    attempts: number;
} | {
    ok: false;
    kind: "no-match";
    message: string;
    attempts: number;
} | {
    ok: false;
    kind: "invalid";
    findings: Finding[];
    lastYaml: string;
    attempts: number;
};
export const SELF_DISCLOSURE = "⚖️ Yarrow (Pulse Composer) is frontier-A (text → YAML is reasoning on a frontier model). " +
    "The flows it emits can still route individual steps local-only — watch the annotations.";
const here = dirname(fileURLToPath(import.meta.url));
export async function loadSystemPrompt(catalog: CatalogEntry[]): Promise<string> {
    const template = await readFile(join(here, "SYSTEM_PROMPT.md"), "utf-8");
    return `${template}\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\`\n`;
}
export function extractFence(text: string, lang: string): string | null {
    const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
    const match = re.exec(text);
    return match?.[1] !== undefined ? match[1].trimEnd() + "\n" : null;
}
function extractSummary(text: string): string {
    const withoutFences = text.replace(/```[a-z]*\s*\n[\s\S]*?```/gi, "");
    const lines = withoutFences
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("⚖️"));
    return lines[lines.length - 1] ?? "";
}
export function composeTier(): "fast" | "standard" | "smart" {
    const t = process.env.PULSE_COMPOSE_TIER;
    return t === "fast" || t === "standard" || t === "smart" ? t : "standard";
}
export async function compose(scenario: string, catalog: CatalogEntry[], llm: ComposerLLM, options: ComposeOptions = {}): Promise<ComposeResult> {
    const maxRetries = options.maxRetries ?? 2;
    const initialFields = options.initialFields ?? ["scenario"];
    const system = options.systemPrompt ?? (await loadSystemPrompt(catalog));
    let prompt = `Scenario from the audience:\n\n${scenario}\n\nCompose the pipeline.`;
    let lastYaml = "";
    let lastFindings: Finding[] = [];
    let attempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attempts++;
        const response = await llm(prompt, { system, tier: composeTier() });
        const text = response.text ?? "";
        const yaml = extractFence(text, "yaml");
        if (!yaml) {
            if (text.trim().length > 0 && (!options.strictReply || /^Closest I have is [\s\S]+; the gap is [\s\S]+/i.test(text.trim()))) {
                if (options.strictReply && lastFindings.some((finding) => finding.rule !== "unknown-block")) {
                    return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
                }
                return { ok: false, kind: "no-match", message: text.trim(), attempts };
            }
            lastFindings = [{ rule: "parse-error", step: -1, message: "composer reply must contain pipeline YAML or an explicit closest-match refusal" }];
            prompt = `Your previous reply was empty. Emit the full response (yaml + mermaid + summary) for the scenario.`;
            continue;
        }
        const validation = validatePipeline(yaml, catalog, { initialFields });
        if (validation.valid) {
            return {
                ok: true,
                yaml,
                mermaid: extractFence(text, "mermaid"),
                summary: extractSummary(text),
                annotations: validation.annotations,
                attempts,
            };
        }
        lastYaml = yaml;
        lastFindings = validation.findings;
        const findingLines = validation.findings
            .map((f) => `- [${f.rule}] step ${f.step}: ${f.message}`)
            .join("\n");
        prompt =
            `Your previous YAML:\n\`\`\`yaml\n${yaml}\`\`\`\n\n` +
                `failed validation:\n${findingLines}\n\n` +
                `Fix exactly these findings and re-emit the full response ` +
                `(yaml + mermaid + summary). Remember: only catalog blocks, ` +
                `sovereignty annotation on every step.`;
    }
    if (options.strictReply) return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
    attempts++;
    let fallback: LLMResponse;
    try {
        fallback = await llm(`You could not produce a valid flow for the scenario after ${maxRetries + 1} attempts. ` +
            `Last validator findings:\n${lastFindings.map((f) => `- ${f.message}`).join("\n")}\n\n` +
            `Reply with ONLY the closest-match message per rule 2 of your instructions ` +
            `(no YAML).`, { system, tier: composeTier() });
    }
    catch (err) {
        console.error(`[compose] closest-match fallback call failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
    }
    const message = (fallback.text ?? "").trim();
    if (message.length > 0 && !extractFence(message, "yaml") && (!options.strictReply || /^Closest I have is [\s\S]+; the gap is [\s\S]+/i.test(message))) {
        return { ok: false, kind: "no-match", message, attempts };
    }
    return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
}
