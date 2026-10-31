import type { ActionRunnerOptions } from "./action-runner";
import type { FlowDef, FlowResult } from "../types/flow";
export declare function runFlow(flow: FlowDef, options: Omit<ActionRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
}): Promise<FlowResult>;
export declare function scheduleFlow(flow: FlowDef, options: Omit<ActionRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
    onRun?: (result: FlowResult) => void;
    onError?: (error: Error) => void;
}): {
    stop: () => void;
};
export declare function loadFlow(yamlPath: string): Promise<FlowDef>;
