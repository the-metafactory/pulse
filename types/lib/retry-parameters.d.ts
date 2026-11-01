import { z } from "zod";
export declare const RetryParametersSchema: z.ZodObject<{
    attempts: z.ZodNumber;
    backoff: z.ZodOptional<z.ZodEnum<["constant", "linear", "exponential"]>>;
    initial_delay_ms: z.ZodOptional<z.ZodNumber>;
    max_delay_ms: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    attempts: number;
    backoff?: "constant" | "linear" | "exponential" | undefined;
    initial_delay_ms?: number | undefined;
    max_delay_ms?: number | undefined;
}, {
    attempts: number;
    backoff?: "constant" | "linear" | "exponential" | undefined;
    initial_delay_ms?: number | undefined;
    max_delay_ms?: number | undefined;
}>;
export declare const RETRY_EDITABLE_FIELDS: readonly [{
    readonly name: "attempts";
    readonly type: "number";
    readonly minimum: number | undefined;
}, {
    readonly name: "backoff";
    readonly type: "string";
    readonly enum: ["constant", "linear", "exponential"];
}, {
    readonly name: "initial_delay_ms";
    readonly type: "number";
    readonly minimum: number | undefined;
}, {
    readonly name: "max_delay_ms";
    readonly type: "number";
    readonly minimum: number | undefined;
}];
