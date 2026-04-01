import type { PulseNodeDef } from "../types/pulse";

/**
 * Detect cycles in a dependency graph using DFS.
 * Returns array of cycle paths (each path is an array of node IDs).
 */
export function detectCycles(nodes: PulseNodeDef[]): string[][] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(nodeId: string, path: string[]): void {
    visited.add(nodeId);
    recStack.add(nodeId);

    const node = nodeMap.get(nodeId);
    for (const dep of node?.dependsOn ?? []) {
      if (!visited.has(dep)) {
        dfs(dep, [...path, dep]);
      } else if (recStack.has(dep)) {
        // Found a cycle — extract the cycle portion
        const cycleStart = path.indexOf(dep);
        if (cycleStart >= 0) {
          cycles.push([...path.slice(cycleStart), dep]);
        } else {
          cycles.push([...path, dep]);
        }
      }
    }

    recStack.delete(nodeId);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id, [node.id]);
    }
  }

  return cycles;
}
