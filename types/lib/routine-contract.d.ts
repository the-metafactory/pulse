import { z } from "zod";
export declare const RoutinePatchSchema: z.ZodObject<{
    path: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber]>, "many">;
    value: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>;
}, "strict", z.ZodTypeAny, {
    path: (string | number)[];
    value: string | number | boolean;
}, {
    path: (string | number)[];
    value: string | number | boolean;
}>;
export declare const RoutineContractInput: z.ZodObject<{
    yaml: z.ZodString;
    patches: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber]>, "many">;
        value: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>;
    }, "strict", z.ZodTypeAny, {
        path: (string | number)[];
        value: string | number | boolean;
    }, {
        path: (string | number)[];
        value: string | number | boolean;
    }>, "many">>;
}, "strict", z.ZodTypeAny, {
    yaml: string;
    patches: {
        path: (string | number)[];
        value: string | number | boolean;
    }[];
}, {
    yaml: string;
    patches?: {
        path: (string | number)[];
        value: string | number | boolean;
    }[] | undefined;
}>;
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>;
declare const field: z.ZodObject<{
    name: z.ZodString;
    type: z.ZodEnum<["string", "number", "boolean"]>;
    minimum: z.ZodOptional<z.ZodNumber>;
    maximum: z.ZodOptional<z.ZodNumber>;
    enum: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">>;
}, "strip", z.ZodTypeAny, {
    type: "string" | "number" | "boolean";
    name: string;
    minimum?: number | undefined;
    maximum?: number | undefined;
    enum?: (string | number | boolean)[] | undefined;
}, {
    type: "string" | "number" | "boolean";
    name: string;
    minimum?: number | undefined;
    maximum?: number | undefined;
    enum?: (string | number | boolean)[] | undefined;
}>;
export declare const RoutineFieldSchema: z.ZodObject<{
    name: z.ZodString;
    type: z.ZodEnum<["string", "number", "boolean"]>;
    minimum: z.ZodOptional<z.ZodNumber>;
    maximum: z.ZodOptional<z.ZodNumber>;
    enum: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">>;
}, "strip", z.ZodTypeAny, {
    type: "string" | "number" | "boolean";
    name: string;
    minimum?: number | undefined;
    maximum?: number | undefined;
    enum?: (string | number | boolean)[] | undefined;
}, {
    type: "string" | "number" | "boolean";
    name: string;
    minimum?: number | undefined;
    maximum?: number | undefined;
    enum?: (string | number | boolean)[] | undefined;
}>;
export declare function routineFieldError(declared: z.infer<typeof field>, value: string | number | boolean): string | null;
export declare const RoutineStepSchema: z.ZodObject<{
    path: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber]>, "many">;
    action: z.ZodString;
    purpose: z.ZodString;
    parameters: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        kind: z.ZodEnum<["literal", "binding", "redacted"]>;
        value: z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    }, "strip", z.ZodTypeAny, {
        kind: "literal" | "binding" | "redacted";
        value: string | number | boolean | null;
        name: string;
    }, {
        kind: "literal" | "binding" | "redacted";
        value: string | number | boolean | null;
        name: string;
    }>, "many">;
    editable: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodEnum<["string", "number", "boolean"]>;
        minimum: z.ZodOptional<z.ZodNumber>;
        maximum: z.ZodOptional<z.ZodNumber>;
        enum: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">>;
    }, "strip", z.ZodTypeAny, {
        type: "string" | "number" | "boolean";
        name: string;
        minimum?: number | undefined;
        maximum?: number | undefined;
        enum?: (string | number | boolean)[] | undefined;
    }, {
        type: "string" | "number" | "boolean";
        name: string;
        minimum?: number | undefined;
        maximum?: number | undefined;
        enum?: (string | number | boolean)[] | undefined;
    }>, "many">;
    reason: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: (string | number)[];
    reason: string;
    action: string;
    purpose: string;
    parameters: {
        kind: "literal" | "binding" | "redacted";
        value: string | number | boolean | null;
        name: string;
    }[];
    editable: {
        type: "string" | "number" | "boolean";
        name: string;
        minimum?: number | undefined;
        maximum?: number | undefined;
        enum?: (string | number | boolean)[] | undefined;
    }[];
}, {
    path: (string | number)[];
    reason: string;
    action: string;
    purpose: string;
    parameters: {
        kind: "literal" | "binding" | "redacted";
        value: string | number | boolean | null;
        name: string;
    }[];
    editable: {
        type: "string" | "number" | "boolean";
        name: string;
        minimum?: number | undefined;
        maximum?: number | undefined;
        enum?: (string | number | boolean)[] | undefined;
    }[];
}>;
export declare const RoutineFlowViewSchema: z.ZodObject<{
    name: z.ZodString;
    steps: z.ZodArray<z.ZodObject<{
        path: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber]>, "many">;
        action: z.ZodString;
        purpose: z.ZodString;
        parameters: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            kind: z.ZodEnum<["literal", "binding", "redacted"]>;
            value: z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
        }, "strip", z.ZodTypeAny, {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }, {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }>, "many">;
        editable: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            type: z.ZodEnum<["string", "number", "boolean"]>;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
            enum: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">>;
        }, "strip", z.ZodTypeAny, {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }, {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }>, "many">;
        reason: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        path: (string | number)[];
        reason: string;
        action: string;
        purpose: string;
        parameters: {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }[];
        editable: {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }[];
    }, {
        path: (string | number)[];
        reason: string;
        action: string;
        purpose: string;
        parameters: {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }[];
        editable: {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }[];
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    name: string;
    steps: {
        path: (string | number)[];
        reason: string;
        action: string;
        purpose: string;
        parameters: {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }[];
        editable: {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }[];
    }[];
}, {
    name: string;
    steps: {
        path: (string | number)[];
        reason: string;
        action: string;
        purpose: string;
        parameters: {
            kind: "literal" | "binding" | "redacted";
            value: string | number | boolean | null;
            name: string;
        }[];
        editable: {
            type: "string" | "number" | "boolean";
            name: string;
            minimum?: number | undefined;
            maximum?: number | undefined;
            enum?: (string | number | boolean)[] | undefined;
        }[];
    }[];
}>;
export type RoutineFlowView = z.infer<typeof RoutineFlowViewSchema>;
export declare function routineContract(input: z.input<typeof RoutineContractInput>): {
    yaml?: string | undefined;
    view: {
        name: string;
        steps: {
            path: (string | number)[];
            reason: string;
            action: string;
            purpose: string;
            parameters: {
                kind: "literal" | "binding" | "redacted";
                value: string | number | boolean | null;
                name: string;
            }[];
            editable: {
                type: "string" | "number" | "boolean";
                name: string;
                minimum?: number | undefined;
                maximum?: number | undefined;
                enum?: (string | number | boolean)[] | undefined;
            }[];
        }[];
    };
};
export {};
