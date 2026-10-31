import type { PipelineStep } from "../types/pipeline";
import { type StepRecord, type StepRunnerOptions } from "./primitive-runner";
export { StepFailure, MapItemFailure, preflightSteps, type StepRecord, type StepRunnerOptions, } from "./primitive-runner";
export declare function validateStep(step: unknown, path?: string): PipelineStep;
export declare function validateSteps(steps: unknown[]): PipelineStep[];
export declare function runSteps(steps: PipelineStep[], payload: Record<string, unknown>, options: StepRunnerOptions, stepRecords?: StepRecord[]): Promise<Record<string, unknown>>;
export declare function runStep(step: PipelineStep, payload: Record<string, unknown>, options: StepRunnerOptions, stepRecords?: StepRecord[]): Promise<Record<string, unknown>>;
