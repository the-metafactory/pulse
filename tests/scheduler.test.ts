import { describe, expect, test } from "bun:test";
import { Scheduler } from "../src/lib/scheduler";
import type { PulseNode } from "../src/types/pulse";

function makeNode(id: string, deps: string[] = [], children: string[] = []): PulseNode {
  return {
    id,
    name: id,
    dependsOn: deps,
    children,
    fn: async () => id,
  };
}

describe("Scheduler", () => {
  test("getReady returns root nodes initially", () => {
    const s = new Scheduler();
    s.initialize([
      makeNode("a", [], ["b"]),
      makeNode("b", ["a"]),
    ]);
    expect(s.getReady()).toEqual(["a"]);
  });

  test("parallel roots are both ready", () => {
    const s = new Scheduler();
    s.initialize([
      makeNode("a"),
      makeNode("b"),
      makeNode("c", ["a", "b"]),
    ]);
    const ready = s.getReady();
    expect(ready).toContain("a");
    expect(ready).toContain("b");
    expect(ready).not.toContain("c");
  });

  test("child becomes ready when all deps done", () => {
    const s = new Scheduler();
    s.initialize([
      makeNode("a", [], ["c"]),
      makeNode("b", [], ["c"]),
      makeNode("c", ["a", "b"]),
    ]);
    s.markRunning("a");
    s.markDone("a", { nodeId: "a", status: "done", attempts: 1 });
    expect(s.getReady()).not.toContain("c"); // b still pending

    s.markRunning("b");
    s.markDone("b", { nodeId: "b", status: "done", attempts: 1 });
    expect(s.getReady()).toContain("c"); // now both deps done
  });

  test("tracks state transitions", () => {
    const s = new Scheduler();
    s.initialize([makeNode("a")]);
    expect(s.getStatus("a")).toBe("pending");
    s.markRunning("a");
    expect(s.getStatus("a")).toBe("running");
    s.markDone("a", { nodeId: "a", status: "done", attempts: 1 });
    expect(s.getStatus("a")).toBe("done");
  });

  test("isComplete when all terminal", () => {
    const s = new Scheduler();
    s.initialize([makeNode("a"), makeNode("b")]);
    expect(s.isComplete()).toBe(false);
    s.markRunning("a");
    s.markDone("a", { nodeId: "a", status: "done", attempts: 1 });
    expect(s.isComplete()).toBe(false);
    s.markRunning("b");
    s.markDone("b", { nodeId: "b", status: "done", attempts: 1 });
    expect(s.isComplete()).toBe(true);
  });

  test("skipSubtree marks descendants as skipped", () => {
    const s = new Scheduler();
    s.initialize([
      makeNode("a", [], ["b"]),
      makeNode("b", ["a"], ["c"]),
      makeNode("c", ["b"]),
    ]);
    s.markRunning("a");
    s.markFailed("a", { nodeId: "a", status: "failed", attempts: 3 });
    s.skipSubtree("a");

    expect(s.getStatus("b")).toBe("skipped");
    expect(s.getStatus("c")).toBe("skipped");
  });

  test("skipSubtree doesn't affect siblings", () => {
    const s = new Scheduler();
    s.initialize([
      makeNode("a", [], ["c"]),
      makeNode("b", [], ["c"]),
      makeNode("c", ["a", "b"]),
    ]);
    s.markRunning("a");
    s.markFailed("a", { nodeId: "a", status: "failed", attempts: 3 });
    s.skipSubtree("a");

    // c is skipped (depends on a), but b is still pending
    expect(s.getStatus("b")).toBe("pending");
    expect(s.getStatus("c")).toBe("skipped");
  });
});
