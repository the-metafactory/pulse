import { describe, expect, test } from "bun:test";
import { detectCycles } from "../src/lib/cycles";

describe("detectCycles", () => {
  test("returns empty for acyclic graph", () => {
    const nodes = [
      { id: "a", name: "A", dependsOn: [] },
      { id: "b", name: "B", dependsOn: ["a"] },
      { id: "c", name: "C", dependsOn: ["b"] },
    ];
    expect(detectCycles(nodes)).toHaveLength(0);
  });

  test("detects simple A→B→A cycle", () => {
    const nodes = [
      { id: "a", name: "A", dependsOn: ["b"] },
      { id: "b", name: "B", dependsOn: ["a"] },
    ];
    const cycles = detectCycles(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });

  test("detects three-node cycle", () => {
    const nodes = [
      { id: "a", name: "A", dependsOn: ["c"] },
      { id: "b", name: "B", dependsOn: ["a"] },
      { id: "c", name: "C", dependsOn: ["b"] },
    ];
    const cycles = detectCycles(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });

  test("handles nodes with no dependencies", () => {
    const nodes = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    expect(detectCycles(nodes)).toHaveLength(0);
  });

  test("handles mixed cyclic and acyclic", () => {
    const nodes = [
      { id: "a", name: "A", dependsOn: ["b"] },
      { id: "b", name: "B", dependsOn: ["a"] },
      { id: "c", name: "C", dependsOn: [] },
      { id: "d", name: "D", dependsOn: ["c"] },
    ];
    const cycles = detectCycles(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });
});
