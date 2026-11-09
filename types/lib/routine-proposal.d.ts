import { z } from "zod";
import { RoutinePatchSchema } from "./routine-contract";
import { type ComposerLLM } from "./composer/compose";
export declare function proposeRoutineEdit(request: string, raw: unknown, llm: ComposerLLM): Promise<{
    status: "edit";
    patches: z.infer<typeof RoutinePatchSchema>[];
}>;
