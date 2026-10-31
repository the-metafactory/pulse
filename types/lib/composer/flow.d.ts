import { type ComposerLLM, type ComposeOptions } from "./compose";
import type { CatalogEntry, Finding } from "./validate-pipeline";
export interface ComposeFlowOptions extends ComposeOptions {
    catalog: CatalogEntry[];
    llm: ComposerLLM;
}
export declare function composeFlow(request: string, options: ComposeFlowOptions): Promise<{
    readonly status: "no-match";
    readonly kind: "missing-capability";
    readonly message: string;
    readonly findings?: undefined;
    readonly flow?: undefined;
    readonly yaml?: undefined;
    readonly summary?: undefined;
    readonly mermaid?: undefined;
} | {
    readonly status: "invalid";
    readonly kind: "off-contract";
    readonly findings: Finding[];
    readonly message?: undefined;
    readonly flow?: undefined;
    readonly yaml?: undefined;
    readonly summary?: undefined;
    readonly mermaid?: undefined;
} | {
    readonly status: "complete";
    readonly flow: import("../pipeline").PipelineDef;
    readonly yaml: string;
    readonly summary: string;
    readonly mermaid: string | null;
    readonly kind?: undefined;
    readonly message?: undefined;
    readonly findings?: undefined;
} | {
    readonly status: "invalid";
    readonly kind: "composition-failed";
    readonly findings: Finding[];
    readonly message?: undefined;
    readonly flow?: undefined;
    readonly yaml?: undefined;
    readonly summary?: undefined;
    readonly mermaid?: undefined;
}>;
export type ComposeFlowResult = Awaited<ReturnType<typeof composeFlow>>;
