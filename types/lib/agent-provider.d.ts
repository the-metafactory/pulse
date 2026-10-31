import type { AgentProvider, AgentTaskSpec, AgentTaskResult, AgentSovereignty, AgentDispatchOptions } from "../types/agent";
export type { AgentProvider, AgentTaskSpec, AgentTaskResult, AgentSovereignty, AgentDispatchOptions } from "../types/agent";
export type TransportHandler = (subject: string, data: string) => void;
export interface AgentTransport {
    publish(subject: string, data: string): Promise<void>;
    subscribe(subject: string, handler: TransportHandler): Promise<() => Promise<void>>;
}
export declare function subjectMatches(pattern: string, subject: string): boolean;
export declare class InMemoryAgentTransport implements AgentTransport {
    private subs;
    publish(subject: string, data: string): Promise<void>;
    subscribe(pattern: string, handler: TransportHandler): Promise<() => Promise<void>>;
    get subscriptionCount(): number;
}
export interface NatsAgentTransportOptions {
    servers?: string;
    credentials?: string;
    name?: string;
}
interface NatsModuleLike {
    connect: (o: {
        servers: string;
        name?: string;
        authenticator?: unknown;
    }) => Promise<unknown>;
    credsAuthenticator: (creds: Uint8Array) => unknown;
}
export declare class NatsAgentTransport implements AgentTransport {
    private nc;
    private constructor();
    static connect(opts?: NatsAgentTransportOptions, loadNats?: () => Promise<NatsModuleLike>): Promise<NatsAgentTransport>;
    publish(subject: string, data: string): Promise<void>;
    subscribe(pattern: string, handler: TransportHandler): Promise<() => Promise<void>>;
    close(): Promise<void>;
}
export interface MyelinEnvelope {
    id: string;
    source: string;
    type: string;
    timestamp: string;
    correlation_id?: string;
    sovereignty: Required<Pick<AgentSovereignty, "classification" | "data_residency" | "max_hop" | "frontier_ok" | "model_class">>;
    payload: Record<string, unknown>;
    requirements?: string[];
    distribution_mode?: "offer" | "direct" | "delegate";
    target_assistant?: string;
    deadline?: string;
}
export declare function encodeDidSegment(did: string): string;
export interface MyelinAgentProviderConfig {
    transport: AgentTransport;
    principal: string;
    stack?: string;
    source?: string;
    sovereigntyDefaults?: AgentSovereignty;
}
export declare class MyelinAgentProvider implements AgentProvider {
    private principal;
    private stack;
    private source;
    private transport;
    private sovereigntyDefaults;
    constructor(config: MyelinAgentProviderConfig);
    taskSubject(spec: AgentTaskSpec): string;
    lifecyclePattern(spec: AgentTaskSpec): string;
    buildEnvelope(spec: AgentTaskSpec, taskId: string): MyelinEnvelope;
    dispatch(spec: AgentTaskSpec, opts?: AgentDispatchOptions): Promise<AgentTaskResult>;
}
export interface MockAgentScript {
    [capability: string]: unknown | ((spec: AgentTaskSpec) => unknown);
}
export declare class MockAgentProvider implements AgentProvider {
    private script;
    private opts;
    dispatched: AgentTaskSpec[];
    constructor(script: MockAgentScript, opts?: {
        delayMs?: number;
        failCapabilities?: string[];
    });
    dispatch(spec: AgentTaskSpec, dispatchOpts?: AgentDispatchOptions): Promise<AgentTaskResult>;
}
