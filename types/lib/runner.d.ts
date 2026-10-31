import { EventEmitter } from "events";
import type { PulseTreeDef, PulseExecution, PulseResult, ValidationResult, ExecutionContext } from "../types/pulse";
export interface PulseRunnerOptions {
    defaultRetries?: number;
    defaultTimeout?: number;
}
export declare class PulseRunner extends EventEmitter {
    private parser;
    private scheduler;
    private executor;
    private registry;
    private lastExecution?;
    private options;
    constructor(options?: PulseRunnerOptions);
    register(nodeId: string, fn: (context: ExecutionContext) => Promise<any>): void;
    registerAll(fns: Record<string, (context: ExecutionContext) => Promise<any>>): void;
    validate(tree: PulseTreeDef): ValidationResult;
    getExecution(): PulseExecution | undefined;
    getResult(nodeId: string): PulseResult | undefined;
    run(tree: PulseTreeDef): Promise<PulseExecution>;
}
