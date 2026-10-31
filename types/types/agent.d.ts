export interface AgentSovereignty {
    classification?: "local" | "federated" | "public";
    data_residency?: string;
    max_hop?: number;
    frontier_ok?: boolean;
    model_class?: "local-only" | "frontier" | "any";
}
export interface AgentFederation {
    principal: string;
    stack?: string;
}
export interface AgentTaskSpec {
    capability: string;
    prompt: string;
    input?: Record<string, unknown>;
    sovereignty?: AgentSovereignty;
    distribution_mode?: "offer" | "direct" | "delegate";
    target_assistant?: string;
    federate?: AgentFederation;
    timeout_ms?: number;
}
export interface AgentTaskResult {
    task_id: string;
    status: "completed" | "failed";
    output: unknown;
    error?: string;
    duration_ms: number;
    agent?: string;
    model?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}
export interface AgentDispatchOptions {
    signal?: AbortSignal;
    onDispatched?: (info: {
        task_id: string;
    }) => void;
}
export interface AgentProvider {
    dispatch(spec: AgentTaskSpec, opts?: AgentDispatchOptions): Promise<AgentTaskResult>;
}
export type AgentEvent = {
    type: "agent.dispatched";
    name: string;
    capability: string;
    task_id: string;
    dispatched_at: string;
} | {
    type: "agent.completed";
    name: string;
    capability: string;
    task_id: string;
    duration_ms: number;
} | {
    type: "agent.failed";
    name: string;
    capability: string;
    task_id: string;
    error: string;
} | {
    type: "agent.timeout";
    name: string;
    capability: string;
    task_id: string;
    timeout_ms: number;
};
export interface AgentStepSpec {
    name: string;
    capability: string;
    prompt: string;
    sovereignty?: AgentSovereignty;
    distribution_mode?: "offer" | "direct" | "delegate";
    target_assistant?: string;
    federate?: AgentFederation;
    timeout_ms?: number;
    collect?: string;
}
