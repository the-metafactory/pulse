import type { ActionInputField, ActionManifest } from "../types/action";
export interface ToolParameters {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
}
export declare function fieldSchema(field: ActionInputField): Record<string, unknown>;
export declare function toolSchema(manifest: ActionManifest, bind?: Record<string, unknown>): ToolParameters;
export declare function toolInput(manifest: ActionManifest, modelArgs: Record<string, unknown>, bind?: Record<string, unknown>): Record<string, unknown>;
export declare function checkToolArgs(manifest: ActionManifest, modelArgs: Record<string, unknown>, bind?: Record<string, unknown>): string | undefined;
export declare function prepareInput(manifest: ActionManifest, input: Record<string, unknown>): {
    input: Record<string, unknown>;
    error?: string;
};
