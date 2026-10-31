import type { Policy, GateDecision } from "./policy";
import type { GateStepSpec, GateResult } from "./pipeline";
import type { TribunalStepSpec, TribunalVerdict } from "./tribunal";
export type GovernedTribunalSpec = Omit<TribunalStepSpec, "collect" | "on_defer">;
export type GovernedGateSpec = Omit<GateStepSpec, "collect" | "prompt"> & {
    prompt?: string;
};
export interface GovernedStepSpec {
    name: string;
    tool: string;
    input_fields: string[];
    policy: Policy;
    tribunal?: GovernedTribunalSpec;
    gate?: GovernedGateSpec;
    collect?: string;
}
export interface GovernedResult {
    name: string;
    outcome: "allow" | "deny";
    resolved_by: "policy" | "tribunal" | "gate";
    l0: GateDecision;
    tribunal?: TribunalVerdict;
    gate?: GateResult;
    evaluated_at: string;
    resolved_at: string;
}
export type GovernedEvent = {
    type: "governed.l0";
    name: string;
    tool: string;
    decision: GateDecision;
    evaluated_at: string;
} | {
    type: "governed.escalated";
    name: string;
    to: "tribunal" | "gate";
    reason: string;
} | {
    type: "governed.resolved";
    name: string;
    result: GovernedResult;
};
