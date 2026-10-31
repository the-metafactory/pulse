import type { GateProvider, ActionStepEvent } from "../../types/pipeline";
import { type StepAnnotation } from "./validate-pipeline";
import { type ComposerLLM } from "./compose";
import { type ThreadPoster } from "./mm";
import type { AgentProvider } from "../../types/agent";
export declare function makeLocalLlmAgentProvider(llm: ComposerLLM): AgentProvider;
export interface OllamaProviderOpts {
    model?: string;
    url?: string;
    timeoutMs?: number;
}
export declare function makeOllamaAgentProvider(opts?: OllamaProviderOpts): AgentProvider;
export interface ApertusProviderOpts {
    apiToken: string;
    productId: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
}
export declare function makeApertusAgentProvider(opts: ApertusProviderOpts): AgentProvider;
export declare function makeApertusAgentProviderFromEnv(): AgentProvider | null;
export declare function makeSovereignAgentProvider(backends: {
    frontier: AgentProvider;
    local: AgentProvider;
}): AgentProvider;
export declare function resolveAgentProvider(llm: ComposerLLM): AgentProvider | undefined;
export declare function stepLine(event: ActionStepEvent, annotations: StepAnnotation[]): string | null;
export declare function makeStubLLM(): ComposerLLM;
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
export declare function fenceSafe(s: string): string;
export declare function channelSafe(s: string): string;
export declare function runScenario(scenario: string, opts: RunScenarioOptions): Promise<RunScenarioResult>;
export declare function composeScenario(scenario: string, opts: {
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
}>;
export declare function runSavedFlow(yaml: string, opts: RunScenarioOptions): Promise<RunScenarioResult>;
