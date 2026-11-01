import { type ComposerLLM } from "./composer/compose";
export declare function proposeRoutineEdit(request: string, raw: unknown, llm: ComposerLLM): Promise<{
    status: "edit";
    patches: {
        path: (string | number)[];
        value: string | number | boolean;
    }[];
}>;
