import type { AgentReturnType } from "../types/agent";
export declare const AGENT_RETURN_TYPES: AgentReturnType[];
export declare function returnInstruction(returns: AgentReturnType): string;
export declare function readAgentReturn(answer: unknown, returns: AgentReturnType, field: string): {
    value: unknown;
} | {
    reason: string;
};
