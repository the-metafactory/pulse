export interface PulseTreeDef {
    id: string;
    nodes: PulseNodeDef[];
}
export interface PulseNodeDef {
    id: string;
    name: string;
    dependsOn?: string[];
    retries?: number;
    timeout?: number;
}
export interface PulseNode extends PulseNodeDef {
    fn: (context: ExecutionContext) => Promise<any>;
    children: string[];
}
export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface PulseResult {
    nodeId: string;
    status: NodeStatus;
    result?: any;
    error?: Error;
    startedAt?: Date;
    completedAt?: Date;
    attempts: number;
}
export interface PulseExecution {
    treeId: string;
    startedAt: Date;
    completedAt?: Date;
    results: Map<string, PulseResult>;
    status: "running" | "completed" | "failed";
}
export interface ExecutionContext {
    parentResults: Map<string, any>;
}
export type PulseEvent = {
    type: "node-start";
    nodeId: string;
} | {
    type: "node-complete";
    nodeId: string;
    result: any;
    duration: number;
} | {
    type: "node-failed";
    nodeId: string;
    error: Error;
    willRetry: boolean;
} | {
    type: "tree-complete";
    treeId: string;
    status: "completed" | "failed";
};
export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
}
export interface ValidationError {
    code: "CYCLE" | "MISSING_DEP" | "MISSING_FN" | "DUPLICATE_ID";
    message: string;
    nodeIds: string[];
}
