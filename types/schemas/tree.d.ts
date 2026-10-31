import { z } from "zod";
export declare const PulseNodeDefSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    dependsOn: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    retries: z.ZodOptional<z.ZodNumber>;
    timeout: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    timeout?: number | undefined;
    dependsOn?: string[] | undefined;
    retries?: number | undefined;
}, {
    id: string;
    name: string;
    timeout?: number | undefined;
    dependsOn?: string[] | undefined;
    retries?: number | undefined;
}>;
export declare const PulseTreeDefSchema: z.ZodObject<{
    id: z.ZodString;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        dependsOn: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        retries: z.ZodOptional<z.ZodNumber>;
        timeout: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        timeout?: number | undefined;
        dependsOn?: string[] | undefined;
        retries?: number | undefined;
    }, {
        id: string;
        name: string;
        timeout?: number | undefined;
        dependsOn?: string[] | undefined;
        retries?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    nodes: {
        id: string;
        name: string;
        timeout?: number | undefined;
        dependsOn?: string[] | undefined;
        retries?: number | undefined;
    }[];
}, {
    id: string;
    nodes: {
        id: string;
        name: string;
        timeout?: number | undefined;
        dependsOn?: string[] | undefined;
        retries?: number | undefined;
    }[];
}>;
