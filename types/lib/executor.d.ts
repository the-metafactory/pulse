import type { PulseNode, PulseResult, ExecutionContext } from "../types/pulse";
export declare class Executor {
    execute(node: PulseNode, context: ExecutionContext, onAttempt?: (attempt: number, willRetry: boolean, error?: Error) => void): Promise<PulseResult>;
}
