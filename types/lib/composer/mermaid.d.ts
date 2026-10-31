export interface RenderOptions {
    cmd?: string[];
    timeoutMs?: number;
}
export declare function renderMermaid(source: string, options?: RenderOptions): Promise<Uint8Array | null>;
