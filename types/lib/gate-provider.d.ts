import type { Readable } from "stream";
import type { GateProvider, GateInput } from "../types/pipeline";
export declare class StdinGateProvider implements GateProvider {
    private readonly input;
    private readonly output;
    private rl;
    private readonly buffered;
    private waiter;
    private closed;
    private inFlight;
    constructor(opts?: {
        input?: Readable;
        output?: NodeJS.WritableStream;
    });
    requestVerdict(spec: {
        name: string;
        prompt: string;
        signal?: AbortSignal;
    }): Promise<GateInput>;
    private runOne;
    private ensureReadline;
    private nextLine;
    close(): void;
}
