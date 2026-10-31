export interface ChatToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export type ChatMessage = {
    role: "system";
    content: string;
} | {
    role: "user";
    content: string;
} | {
    role: "assistant";
    content: string | null;
    tool_calls?: ChatToolCall[];
} | {
    role: "tool";
    tool_call_id: string;
    content: string;
};
export interface ChatTool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface ChatRequest {
    messages: ChatMessage[];
    tools?: ChatTool[];
    maxTokens?: number;
    temperature?: number;
}
export interface ChatResponse {
    content: string | null;
    toolCalls: ChatToolCall[];
    finishReason?: string;
    usage?: {
        input: number;
        output: number;
    };
    reasoning?: string;
}
export interface ChatModel {
    readonly label: string;
    complete(request: ChatRequest, options?: {
        signal?: AbortSignal;
    }): Promise<ChatResponse>;
}
export declare class ModelUnavailableError extends Error {
    readonly model: string;
    readonly reason: string;
    readonly detail?: string;
    readonly unreachable: boolean;
    constructor(model: string, reason: string, extra?: {
        detail?: string;
        unreachable?: boolean;
    });
}
export declare class ModelError extends Error {
    readonly model: string;
    readonly detail?: string | undefined;
    constructor(model: string, message: string, detail?: string | undefined);
}
export interface OpenAICompatibleConfig {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    env?: Record<string, string | undefined>;
    label?: string;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    fetch?: typeof globalThis.fetch;
}
export declare class OpenAICompatibleChatModel implements ChatModel {
    readonly label: string;
    private readonly config;
    constructor(config: OpenAICompatibleConfig);
    complete(request: ChatRequest, options?: {
        signal?: AbortSignal;
    }): Promise<ChatResponse>;
    private redact;
}
export declare function parseChatResponse(data: any, label: string): ChatResponse;
