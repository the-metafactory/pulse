import type { ActionRunnerOptions } from "./action-runner";
import type { ChatModel } from "./chat-model";
import type { ActionStepEvent, AgentEvent, GateEvent, GateProvider, GateResult } from "../types/pipeline";
import type { TribunalEvent, TribunalVerdict } from "../types/tribunal";
import type { GovernedEvent, GovernedResult } from "../types/governed";
import type { ResearchEvent, ResearchStats } from "../types/research";
export interface StepRecord {
    action: string;
    success: boolean;
    durationMs: number;
    error?: string;
    gate?: GateResult;
    tribunal?: TribunalVerdict;
    governed?: GovernedResult;
    research?: ResearchStats;
}
export interface StepRunnerOptions extends ActionRunnerOptions {
    mode?: "local" | "cloud";
    signal?: AbortSignal;
    gateProvider?: GateProvider;
    onActionStepEvent?: (event: ActionStepEvent) => void;
    onGateEvent?: (event: GateEvent) => void;
    onAgentEvent?: (event: AgentEvent) => void;
    onTribunalEvent?: (event: TribunalEvent) => void;
    onGovernedEvent?: (event: GovernedEvent) => void;
    models?: Record<string, ChatModel>;
    transcriptDir?: string;
    onResearchEvent?: (event: ResearchEvent) => void;
}
export interface RunState {
    preflight: Map<object, unknown>;
    unavailableModels: Map<string, string>;
}
export declare function withRunState(options: StepRunnerOptions): StepRunnerOptions;
export declare function runState(options: StepRunnerOptions): RunState | undefined;
export declare function renderPromptTemplate(template: string, payload: Record<string, unknown>): string;
