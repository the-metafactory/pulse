import type { ActionCapabilities, CapabilityName, LLMOptions, LLMResponse } from "../types/action";
import { type ChatModel } from "./chat-model";
export interface LocalCapabilityOptions {
    shellArgvOnly?: boolean;
    signal?: AbortSignal;
    llmModel?: ChatModel;
}
export declare const FALLBACK_LLM_LABEL = "fallback";
type LLMFunction = (prompt: string, options?: LLMOptions) => Promise<LLMResponse>;
export declare function llmModelLabel(llm: LLMFunction): string | undefined;
export declare function createLocalCapabilities(required?: CapabilityName[], options?: LocalCapabilityOptions): Promise<ActionCapabilities>;
export declare function chatModelLLM(model: ChatModel, signal?: AbortSignal): LLMFunction;
export declare function createLocalShell(options?: LocalCapabilityOptions): (cmd: string | string[]) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
}>;
export declare function createCloudCapabilities(required?: CapabilityName[], _env?: Record<string, unknown>): Promise<ActionCapabilities>;
export {};
