import type { PipelineStep } from "./pipeline";
export type FlowSource = {
    type: "rss";
    url: string;
    limit?: number;
} | {
    type: "webhook";
    path: string;
} | {
    type: "file";
    path: string;
    watch?: boolean;
} | {
    type: "inline";
    data: Record<string, unknown>;
} | {
    type: "custom";
    fn: () => Promise<Record<string, unknown>>;
};
export type FlowDestination = {
    type: "file";
    path: string;
    format?: "json" | "markdown";
} | {
    type: "stdout";
} | {
    type: "webhook";
    url: string;
    method?: string;
    headers?: Record<string, string>;
} | {
    type: "custom";
    fn: (output: Record<string, unknown>) => Promise<void>;
};
export interface FlowSchedule {
    cron?: string;
    intervalSeconds?: number;
}
export interface FlowDef {
    name: string;
    description?: string;
    source: FlowSource;
    pipeline: string | {
        actions: PipelineStep[];
    };
    destination: FlowDestination;
    schedule?: FlowSchedule;
    input?: Record<string, unknown>;
    mode?: "local" | "cloud";
}
export interface FlowResult {
    flowName: string;
    success: boolean;
    sourceData?: Record<string, unknown>;
    pipelineOutput?: Record<string, unknown>;
    destinationWritten: boolean;
    error?: string;
    failedStage?: "source" | "pipeline" | "destination";
    durationMs: number;
    startedAt: string;
    completedAt: string;
}
