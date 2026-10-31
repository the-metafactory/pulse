import { type ExecutionRunFinishedEvent, type ExecutionRunServes, type RunOutcome, type TransportPublisher, type TransportSubscriber } from "@the-metafactory/myelin";
export interface RunLedgerConfig {
    principal: string;
    stack: string;
    servers: string;
    credentials?: string;
    path: string;
    correlationId?: string;
    serves?: ExecutionRunServes;
}
export interface RunLedgerPublisher {
    drained: Promise<unknown>;
    publish(event: ExecutionRunFinishedEvent): Promise<void>;
    close(): Promise<void>;
}
export type RunLedgerPublisherFactory = (config: RunLedgerConfig, log: (message: string) => void, signal: AbortSignal) => Promise<RunLedgerPublisher>;
export declare function setRunLedgerPublisher(factory: RunLedgerPublisherFactory): () => void;
export declare function createOutboxRunLedgerPublisher(inner: TransportPublisher & TransportSubscriber, config: RunLedgerConfig, log: (message: string) => void): RunLedgerPublisher;
interface FinishedRun {
    outcome: RunOutcome;
    startedAt?: string;
    endedAt?: string;
}
export declare function withRunLedger<T>(ref: string, body: () => Promise<T>, summarize: (result: T) => FinishedRun): Promise<T>;
export {};
