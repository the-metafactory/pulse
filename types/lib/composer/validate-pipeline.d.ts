import type { PipelineStep } from "../../types/pipeline";
export interface CatalogEntry {
    name: string;
    description: string;
    input: Record<string, {
        type: string;
        required?: boolean;
    }>;
    output: Record<string, {
        type: string;
    }>;
    requires?: string[];
    tags?: string[];
}
export type SovereigntyClass = "D" | "A" | "H";
export interface StepAnnotation {
    index: number;
    label: string;
    sovereignty?: SovereigntyClass;
    residency?: string;
}
export type FindingRule = "parse-error" | "unknown-block" | "missing-input" | "missing-annotation" | "missing-delivery";
export interface Finding {
    rule: FindingRule;
    step: number;
    message: string;
}
export interface ValidationResult {
    valid: boolean;
    findings: Finding[];
    annotations: StepAnnotation[];
}
export interface ValidatePipelineOptions {
    initialFields?: string[];
}
export declare function childActions(step: Exclude<PipelineStep, string>): PipelineStep[][];
export declare function stepOutputs(step: PipelineStep, byName: Map<string, CatalogEntry>): string[];
export declare function validatePipeline(rawYaml: string, catalog: CatalogEntry[], options?: ValidatePipelineOptions): ValidationResult;
