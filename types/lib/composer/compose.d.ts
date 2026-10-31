import type { LLMOptions, LLMResponse } from "../../types/action";
import { type CatalogEntry, type Finding, type StepAnnotation } from "./validate-pipeline";
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
export declare const SELF_DISCLOSURE: string;
export declare function loadSystemPrompt(catalog: CatalogEntry[]): Promise<string>;
export declare function extractFence(text: string, lang: string): string | null;
export declare function composeTier(): "fast" | "standard" | "smart";
export declare function compose(scenario: string, catalog: CatalogEntry[], llm: ComposerLLM, options?: ComposeOptions): Promise<ComposeResult>;
