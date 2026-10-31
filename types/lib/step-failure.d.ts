export declare class StepFailure extends Error {
    readonly step: string;
    readonly causeError: string;
    constructor(step: string, causeError: string);
}
export declare class MapItemFailure extends Error {
    readonly index: number;
    readonly item: unknown;
    readonly causeError: string;
    readonly original?: unknown | undefined;
    constructor(index: number, item: unknown, causeError: string, original?: unknown | undefined);
}
export declare function recordPartialPayload(err: unknown, payload: Record<string, unknown>): void;
export declare function partialPayload(err: unknown): Record<string, unknown> | undefined;
