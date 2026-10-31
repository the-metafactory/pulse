import { type ResolvedAction } from "./action-runner";
import { StepFailure } from "./step-failure";
import { type StepRecord, type StepRunnerOptions } from "./step-options";
import type { ResearchStepSpec } from "../types/research";
export declare class ResearchUnavailable extends StepFailure {
    readonly reason: string;
    constructor(step: string, reason: string);
}
export declare function validateResearch(spec: Record<string, unknown>, path: string): void;
export declare function checkResearchTools(spec: ResearchStepSpec, actionDirs: string[]): Promise<Map<string, ResolvedAction>>;
export declare function runResearch(spec: ResearchStepSpec, payload: Record<string, unknown>, options: StepRunnerOptions, stepRecords: StepRecord[]): Promise<Record<string, unknown>>;
