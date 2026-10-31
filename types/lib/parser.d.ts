import type { PulseTreeDef, PulseNode, ValidationResult } from "../types/pulse";
export declare class TreeParser {
    parse(json: unknown): PulseTreeDef;
    validate(tree: PulseTreeDef): ValidationResult;
    hydrate(tree: PulseTreeDef, registry: Map<string, (context: any) => Promise<any>>): PulseNode[];
}
