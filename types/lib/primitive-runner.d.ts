import type { PipelineStep } from "../types/pipeline";
import { StepFailure, MapItemFailure } from "./step-failure";
import { renderPromptTemplate, type StepRecord, type StepRunnerOptions } from "./step-options";
export { StepFailure, MapItemFailure, renderPromptTemplate };
export type { StepRecord, StepRunnerOptions };
type ValidateStep = (step: unknown, path?: string) => PipelineStep;
type RunSteps = (steps: PipelineStep[], payload: Record<string, unknown>, options: StepRunnerOptions, stepRecords: StepRecord[]) => Promise<Record<string, unknown>>;
interface PrimitiveRuntime {
    runSteps: RunSteps;
}
export declare function preflightSteps(steps: PipelineStep[], options: StepRunnerOptions): Promise<StepRunnerOptions>;
export declare function validatePrimitiveStep(step: Record<string, unknown>, path: string, validateStep: ValidateStep): PipelineStep;
export declare function runPrimitiveStep(step: Exclude<PipelineStep, string>, payload: Record<string, unknown>, options: StepRunnerOptions, stepRecords: StepRecord[], runtime: PrimitiveRuntime): Promise<Record<string, unknown>>;
