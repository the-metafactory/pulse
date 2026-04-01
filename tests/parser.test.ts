import { describe, expect, test } from "bun:test";
import { TreeParser } from "../src/lib/parser";

const parser = new TreeParser();

describe("TreeParser.parse", () => {
  test("parses valid tree JSON", () => {
    const tree = parser.parse({
      id: "test",
      nodes: [{ id: "a", name: "Node A" }],
    });
    expect(tree.id).toBe("test");
    expect(tree.nodes).toHaveLength(1);
  });

  test("rejects empty id", () => {
    expect(() => parser.parse({ id: "", nodes: [{ id: "a", name: "A" }] })).toThrow();
  });

  test("rejects missing nodes", () => {
    expect(() => parser.parse({ id: "test" })).toThrow();
  });

  test("rejects empty nodes array", () => {
    expect(() => parser.parse({ id: "test", nodes: [] })).toThrow();
  });

  test("rejects invalid retries (negative)", () => {
    expect(() =>
      parser.parse({
        id: "test",
        nodes: [{ id: "a", name: "A", retries: -1 }],
      })
    ).toThrow();
  });

  test("rejects invalid timeout (too low)", () => {
    expect(() =>
      parser.parse({
        id: "test",
        nodes: [{ id: "a", name: "A", timeout: 50 }],
      })
    ).toThrow();
  });

  test("accepts valid retries and timeout", () => {
    const tree = parser.parse({
      id: "test",
      nodes: [{ id: "a", name: "A", retries: 3, timeout: 5000 }],
    });
    expect(tree.nodes[0].retries).toBe(3);
    expect(tree.nodes[0].timeout).toBe(5000);
  });
});

describe("TreeParser.validate", () => {
  test("validates acyclic tree", () => {
    const result = parser.validate({
      id: "test",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B", dependsOn: ["a"] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("detects duplicate IDs", () => {
    const result = parser.validate({
      id: "test",
      nodes: [
        { id: "a", name: "A" },
        { id: "a", name: "A duplicate" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "DUPLICATE_ID")).toBe(true);
  });

  test("detects missing dependency", () => {
    const result = parser.validate({
      id: "test",
      nodes: [{ id: "a", name: "A", dependsOn: ["nonexistent"] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_DEP")).toBe(true);
  });

  test("detects cycles", () => {
    const result = parser.validate({
      id: "test",
      nodes: [
        { id: "a", name: "A", dependsOn: ["b"] },
        { id: "b", name: "B", dependsOn: ["a"] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "CYCLE")).toBe(true);
  });
});

describe("TreeParser.hydrate", () => {
  test("computes children from dependsOn", () => {
    const tree = {
      id: "test",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B", dependsOn: ["a"] },
        { id: "c", name: "C", dependsOn: ["a"] },
      ],
    };
    const registry = new Map<string, any>([
      ["a", async () => 1],
      ["b", async () => 2],
      ["c", async () => 3],
    ]);
    const nodes = parser.hydrate(tree, registry);
    const nodeA = nodes.find((n) => n.id === "a")!;
    expect(nodeA.children).toContain("b");
    expect(nodeA.children).toContain("c");
  });

  test("throws on missing function", () => {
    const tree = {
      id: "test",
      nodes: [{ id: "a", name: "A" }],
    };
    const registry = new Map<string, any>();
    expect(() => parser.hydrate(tree, registry)).toThrow("Missing registered functions");
  });
});
