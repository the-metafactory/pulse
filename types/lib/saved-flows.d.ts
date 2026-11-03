export declare const SAVED_FLOW_NAME: RegExp;
export declare const SAVED_FLOW_REQUEST_ID: RegExp;
export interface SavedFlowProvenance {
    origin: "conversation" | "cli";
    conversation: string | null;
    exchange: string | null;
    request_id: string;
    saved_at: string;
    saved_by: string;
}
export interface SavedFlowFinding {
    rule: string;
    message: string;
}
export type SaveFlowResult = {
    status: "saved";
    name: string;
    path: string;
    sha256: string;
} | {
    status: "exists";
    name: string;
    path: string;
    sha256: string;
} | {
    status: "conflict";
    reason: string;
} | {
    status: "invalid";
    findings: SavedFlowFinding[];
} | {
    status: "unreadable";
    reason: string;
};
export interface FlowRecord {
    name: string;
    path: string;
    source: "saved" | "arc";
    sha256: string;
    provenance: SavedFlowProvenance | null;
    yaml: string;
}
export type ShowFlowResult = ({
    status: "found";
} & FlowRecord) | {
    status: "not-found";
} | {
    status: "unreadable";
    reason: string;
};
export interface ListedFlow {
    name: string;
    source: "saved" | "arc";
    path: string;
    package: string | null;
    sha256: string | null;
    provenance: SavedFlowProvenance | null;
}
export type ListFlowsResult = {
    status: "ok";
    flows: ListedFlow[];
} | {
    status: "unreadable";
    reason: string;
};
export interface SavedFlowLocation {
    flowsDir?: string;
    reposDir?: string;
}
export interface SaveFlowRequest extends SavedFlowLocation {
    yaml: string;
    requestId: string;
    conversation?: string;
    exchange?: string;
    savedBy?: string;
    now?: () => Date;
}
export declare function defaultFlowsDir(env?: Record<string, string | undefined>): string;
export declare function flowContentHash(document: Record<string, unknown>): string;
export declare function saveFlow(request: SaveFlowRequest): Promise<SaveFlowResult>;
export declare function showFlow(query: SavedFlowLocation & ({
    name: string;
} | {
    requestId: string;
})): Promise<ShowFlowResult>;
export declare function listFlows(location?: SavedFlowLocation): Promise<ListFlowsResult>;
