import type { AgentStepSpec } from "./agent";
import type { TribunalStepSpec } from "./tribunal";
import type { GovernedStepSpec } from "./governed";
import type { ResearchStepSpec } from "./research";
export type { AgentStepSpec, AgentSovereignty, AgentTaskSpec, AgentTaskResult, AgentProvider, AgentEvent, } from "./agent";
export type { TribunalStepSpec, SeatSpec, SeatVote, SeatVerdict, TribunalRuling, TribunalVerdict, TribunalDiversity, TribunalEvent, } from "./tribunal";
export type { GovernedStepSpec, GovernedResult, GovernedEvent, GovernedTribunalSpec, GovernedGateSpec, } from "./governed";
export type { ResearchStepSpec, ResearchStats, ResearchEvent } from "./research";
export type PipelineStep = string | {
    map: MapStepSpec;
} | {
    filter: FilterStepSpec;
} | {
    reduce: ReduceStepSpec;
} | {
    parallel: ParallelStepSpec;
} | {
    retry: RetryStepSpec;
} | {
    gate: GateStepSpec;
} | {
    agent: AgentStepSpec;
} | {
    tribunal: TribunalStepSpec;
} | {
    governed: GovernedStepSpec;
} | {
    research: ResearchStepSpec;
};
export interface MapStepSpec {
    over: string;
    as: string;
    actions: PipelineStep[];
    collect: string;
    concurrency?: number;
    onError?: "stop" | "skip" | "collect";
}
export interface FilterStepSpec {
    over: string;
    as: string;
    actions: PipelineStep[];
    keep_field: string;
    collect: string;
    concurrency?: number;
    onError?: "stop" | "skip";
}
export interface ReduceStepSpec {
    over: string;
    init: unknown;
    item_as: string;
    acc_as: string;
    actions: PipelineStep[];
    collect: string;
    onError?: "stop";
}
export interface ParallelStepSpec {
    branches: Record<string, {
        actions: PipelineStep[];
    }>;
    onError?: "stop" | "collect";
}
export interface RetryStepSpec {
    attempts: number;
    backoff?: "constant" | "linear" | "exponential";
    initial_delay_ms?: number;
    max_delay_ms?: number;
    on?: string[];
    actions: PipelineStep[];
}
export type ActionStepEvent = {
    type: "step.started";
    action: string;
    started_at: string;
} | {
    type: "step.completed";
    action: string;
    durationMs: number;
    output_fields: string[];
} | {
    type: "step.failed";
    action: string;
    durationMs: number;
    error: string;
};
export type GateVerdict = "pass" | "fail";
export interface GateInput {
    verdict: GateVerdict;
    notes: string;
}
export interface GateResult extends GateInput {
    name: string;
    opened_at: string;
    closed_at: string;
}
export interface GateProvider {
    requestVerdict(spec: {
        name: string;
        prompt: string;
        signal?: AbortSignal;
    }): Promise<GateInput>;
}
export type GateEvent = {
    type: "gate.opened";
    name: string;
    prompt: string;
    opened_at: string;
} | {
    type: "gate.closed";
    name: string;
    verdict: GateVerdict;
    notes: string;
    opened_at: string;
    closed_at: string;
} | {
    type: "gate.timeout";
    name: string;
    opened_at: string;
    timeout_ms: number;
};
export interface GateStepSpec {
    name: string;
    prompt: string;
    timeout_ms?: number;
    collect?: string;
}
