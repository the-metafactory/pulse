import { PulseTreeDefSchema } from "../schemas/tree";
import { detectCycles } from "./cycles";
import type {
  PulseTreeDef,
  PulseNode,
  ValidationResult,
  ValidationError,
} from "../types/pulse";

export class TreeParser {
  /** Parse and validate JSON against Zod schema */
  parse(json: unknown): PulseTreeDef {
    return PulseTreeDefSchema.parse(json);
  }

  /** Semantic validation: cycles, missing deps, duplicate IDs */
  validate(tree: PulseTreeDef): ValidationResult {
    const errors: ValidationError[] = [];

    // Check duplicate IDs
    const ids = tree.nodes.map((n) => n.id);
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
    if (dupes.size > 0) {
      errors.push({
        code: "DUPLICATE_ID",
        message: `Duplicate node IDs: ${[...dupes].join(", ")}`,
        nodeIds: [...dupes],
      });
    }

    // Check missing dependencies
    const idSet = new Set(ids);
    for (const node of tree.nodes) {
      for (const dep of node.dependsOn ?? []) {
        if (!idSet.has(dep)) {
          errors.push({
            code: "MISSING_DEP",
            message: `Node "${node.id}" depends on unknown node "${dep}"`,
            nodeIds: [node.id, dep],
          });
        }
      }
    }

    // Check cycles
    const cycles = detectCycles(tree.nodes);
    for (const cycle of cycles) {
      errors.push({
        code: "CYCLE",
        message: `Dependency cycle detected: ${cycle.join(" → ")}`,
        nodeIds: cycle,
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /** Hydrate tree with registered functions, compute children */
  hydrate(
    tree: PulseTreeDef,
    registry: Map<string, (context: any) => Promise<any>>
  ): PulseNode[] {
    // Check all nodes have registered functions
    const missingFns: string[] = [];
    for (const node of tree.nodes) {
      if (!registry.has(node.id)) {
        missingFns.push(node.id);
      }
    }
    if (missingFns.length > 0) {
      throw new Error(
        `Missing registered functions for nodes: ${missingFns.join(", ")}`
      );
    }

    // Compute children (inverse of dependsOn)
    const childrenMap = new Map<string, string[]>();
    for (const node of tree.nodes) {
      childrenMap.set(node.id, []);
    }
    for (const node of tree.nodes) {
      for (const dep of node.dependsOn ?? []) {
        childrenMap.get(dep)?.push(node.id);
      }
    }

    return tree.nodes.map((node) => ({
      ...node,
      fn: registry.get(node.id)!,
      children: childrenMap.get(node.id) ?? [],
    }));
  }
}
