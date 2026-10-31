import type { ActionCapabilities } from "../types/action";
import type { GateDecision, Policy } from "../types/policy";
export declare const DENY_ALL: Policy;
export interface PolicyLoadResult {
    policy: Policy;
    ok: boolean;
    error?: string;
}
export declare function loadPolicy(path: string): Promise<PolicyLoadResult>;
export type GateAuditHook = (event: {
    tool: string;
    input: Record<string, unknown>;
    decision: GateDecision;
}) => void;
export interface GuardOptions {
    policy: Policy;
    onDecision?: GateAuditHook;
    auditOnly?: boolean;
}
declare class PolicyDenial extends Error {
    constructor(tool: string, decision: GateDecision);
}
export declare function shellGateInput(cmd: string | string[]): Record<string, unknown>;
export declare function guardCapabilities(caps: ActionCapabilities, opts: GuardOptions): ActionCapabilities;
export { PolicyDenial };
