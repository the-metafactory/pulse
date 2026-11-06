import { z } from "zod";
import type { PipelineStep } from "../../types/pipeline";
import { type ComposerLLM } from "./compose";
import { type CatalogEntry, type Finding } from "./validate-pipeline";
export declare const ONLY_OWN_ADDRESSES = "A routine can mail only your own configured addresses, so it cannot mail anyone else. Ask it to \"mail me\" if the mail is for you.";
declare const DeliveryAskSchema: z.ZodObject<{
    channels: z.ZodArray<z.ZodString, "many">;
    send: z.ZodBoolean;
    mailsSomeoneElse: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    send: boolean;
    channels: string[];
    mailsSomeoneElse: boolean;
}, {
    send: boolean;
    channels: string[];
    mailsSomeoneElse: boolean;
}>;
export type DeliveryAsk = z.infer<typeof DeliveryAskSchema>;
export declare function readDeliveryAsk(request: string, llm: ComposerLLM): Promise<DeliveryAsk>;
export declare function deliveryGap(ask: DeliveryAsk, catalog: CatalogEntry[]): string | null;
export declare function readFlow(yaml: string): {
    steps: PipelineStep[];
    input: Record<string, unknown>;
};
export declare function deliveryFindings(ask: DeliveryAsk, yaml: string, catalog: CatalogEntry[]): Finding[];
export declare function choosesMailRecipient(yaml: string, catalog: CatalogEntry[]): boolean;
export {};
