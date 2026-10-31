import type { AgentTaskSpec, AgentTaskResult } from "./agent";
export interface ActionCapabilities {
    llm?: (prompt: string, options?: LLMOptions) => Promise<LLMResponse>;
    agent?: (task: AgentTaskSpec) => Promise<AgentTaskResult>;
    fetch?: typeof globalThis.fetch;
    shell?: (cmd: string | string[]) => Promise<ShellResult>;
    readFile?: (path: string) => Promise<string>;
    writeFile?: (path: string, content: string) => Promise<void>;
    kv?: {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string, ttl?: number) => Promise<void>;
        delete: (key: string) => Promise<void>;
    };
}
export type CapabilityName = "llm" | "agent" | "fetch" | "shell" | "readFile" | "writeFile" | "kv";
export interface LLMOptions {
    tier?: "fast" | "standard" | "smart";
    system?: string;
    json?: boolean;
    maxTokens?: number;
}
export interface LLMResponse {
    text: string;
    json?: unknown;
    usage?: {
        input: number;
        output: number;
    };
}
export interface ShellResult {
    stdout: string;
    stderr: string;
    code: number;
}
export type ActionEffect = "read" | "write";
export interface ActionInputField {
    type: string;
    required?: boolean;
    description?: string;
    enum?: unknown[];
    default?: unknown;
    items?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    minimum?: number;
    maximum?: number;
    [keyword: string]: unknown;
}
export interface ActionManifest {
    name: string;
    version: string;
    description: string;
    input: Record<string, ActionInputField>;
    output: Record<string, {
        type: string;
    }>;
    effect?: ActionEffect;
    requires?: CapabilityName[];
    tags?: string[];
    author?: {
        name: string;
        url?: string;
    };
    license?: string;
    deployment?: {
        timeout?: number;
        memory?: number;
        secrets?: string[];
    };
}
export interface ActionContext {
    capabilities: ActionCapabilities;
    env: {
        mode: "local" | "cloud";
    };
    trace?: {
        traceId: string;
        spanId: string;
    };
    signal?: AbortSignal;
    pipeline?: {
        name: string;
        stepIndex: number;
    };
}
export interface ActionImplementation<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
    execute: (input: TInput, ctx: ActionContext) => Promise<TOutput>;
}
export interface ActionResult<T = unknown> {
    success: boolean;
    output?: T;
    error?: string;
    metadata?: {
        durationMs: number;
        action: string;
        mode: "local" | "cloud";
    };
}
