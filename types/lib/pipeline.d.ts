import { type StepRunnerOptions } from "./step-runner";
import type { PipelineStep } from "../types/pipeline";
export interface PipelineDef {
    name: string;
    actions: PipelineStep[];
    description?: string;
}
export declare function loadPipeline(yamlPath: string): Promise<{
    pipeline: PipelineDef;
    baseDir: string;
}>;
export declare function parsePipeline(content: string, source?: string): PipelineDef;
export declare function runPipelineFromYaml(yamlPath: string, initialInput: Record<string, unknown>, options: Omit<StepRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
}): Promise<PipelineResult>;
export declare function discoverPipelines(dir: string): Promise<Array<{
    pipeline: PipelineDef;
    yamlPath: string;
    baseDir: string;
}>>;
export interface PipelineResult {
    success: boolean;
    output?: Record<string, unknown>;
    error?: string;
    cause?: unknown;
    steps: Array<{
        action: string;
        success: boolean;
        durationMs: number;
        error?: string;
    }>;
    durationMs: number;
}
export declare function runPipeline(pipeline: PipelineDef, initialInput: Record<string, unknown>, options: StepRunnerOptions): Promise<PipelineResult>;
