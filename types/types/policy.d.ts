export type Decision = "allow" | "ask" | "deny";
export interface PolicyRule {
    tool?: string;
    match?: Record<string, string>;
    decision?: Decision;
    reason?: string;
}
export interface Policy {
    version: number;
    default?: Decision;
    rules?: PolicyRule[];
}
export interface GateDecision {
    decision: Decision;
    reason: string;
    rule_index: number;
}
