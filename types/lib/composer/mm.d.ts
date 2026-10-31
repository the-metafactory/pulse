import type { GateInput, GateProvider } from "../../types/pipeline";
export interface MMConfig {
    url: string;
    token: string;
    channelId: string;
    operatorId: string;
}
export declare function mmConfigFromEnv(): MMConfig | null;
export interface ThreadPoster {
    post(message: string, file?: {
        bytes: Uint8Array;
        filename: string;
    }): Promise<string>;
}
export declare class ConsolePoster implements ThreadPoster {
    readonly posts: string[];
    private counter;
    post(message: string, file?: {
        bytes: Uint8Array;
        filename: string;
    }): Promise<string>;
}
export declare class MattermostThread implements ThreadPoster {
    private readonly cfg;
    private readonly fetchFn;
    private rootId;
    private lastSeen;
    constructor(cfg: MMConfig, fetchFn?: typeof globalThis.fetch);
    private headers;
    post(message: string, file?: {
        bytes: Uint8Array;
        filename: string;
    }): Promise<string>;
    waitForReply(matcher: RegExp, opts?: {
        timeoutMs?: number;
        pollMs?: number;
        signal?: AbortSignal;
    }): Promise<string>;
}
export declare const ACK_VOCAB_RE: RegExp;
export declare function parseAckReply(text: string): GateInput | null;
export declare class MMAckGateProvider implements GateProvider {
    private readonly thread;
    constructor(thread: MattermostThread);
    requestVerdict(spec: {
        name: string;
        prompt: string;
        signal?: AbortSignal;
    }): Promise<GateInput>;
}
