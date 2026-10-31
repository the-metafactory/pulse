import type { GateDecision, Policy } from "../types/policy";
export declare function evaluate(toolName: unknown, toolInput: unknown, policy: Policy | null | undefined): GateDecision;
