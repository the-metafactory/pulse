import type { PulseNode, PulseResult, NodeStatus } from "../types/pulse";
export declare class Scheduler {
    private nodes;
    private statuses;
    private results;
    initialize(nodes: PulseNode[]): void;
    getReady(): string[];
    checkDependencies(nodeId: string): boolean;
    markRunning(nodeId: string): void;
    markDone(nodeId: string, result: PulseResult): void;
    markFailed(nodeId: string, result: PulseResult): void;
    skipSubtree(nodeId: string): void;
    getStatus(nodeId: string): NodeStatus | undefined;
    getResult(nodeId: string): PulseResult | undefined;
    getAllResults(): Map<string, PulseResult>;
    isComplete(): boolean;
}
