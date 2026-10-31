import { type GateAuditHook } from "./policy-loader";
import type { Policy } from "../types/policy";
import type { ActionManifest, ActionResult } from "../types/action";
import type { AgentProvider } from "../types/agent";
import type { ChatModel } from "./chat-model";
export interface ActionRunnerOptions {
    actionDirs: string[];
    defaultMode?: "local" | "cloud";
    cloudUrlPattern?: string;
    agentProvider?: AgentProvider;
    llmModel?: ChatModel;
    policy?: Policy;
    onGateDecision?: GateAuditHook;
    shellArgvOnly?: boolean;
    signal?: AbortSignal;
}
export interface ResolvedAction {
    path: string;
    manifest: ActionManifest;
}
export declare function resolveAction(name: string, dirs: string[]): Promise<ResolvedAction | null>;
export declare function runAction<TInput = Record<string, unknown>, TOutput = unknown>(name: string, input: TInput, options: ActionRunnerOptions & {
    mode?: "local" | "cloud";
    traceId?: string;
    resolved?: ResolvedAction;
}): Promise<ActionResult<TOutput>>;
export declare function listActions(dirs: string[]): Promise<ActionManifest[]>;
