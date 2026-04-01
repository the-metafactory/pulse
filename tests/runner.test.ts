import { describe, expect, test } from "bun:test";
import { PulseRunner } from "../src/lib/runner";
import type { PulseEvent } from "../src/types/pulse";

describe("PulseRunner", () => {
  test("executes simple linear tree", async () => {
    const runner = new PulseRunner();
    runner.registerAll({
      a: async () => "result-a",
      b: async (ctx) => `${ctx.parentResults.get("a")}-b`,
    });

    const execution = await runner.run({
      id: "linear",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B", dependsOn: ["a"] },
      ],
    });

    expect(execution.status).toBe("completed");
    expect(execution.results.get("a")?.result).toBe("result-a");
    expect(execution.results.get("b")?.result).toBe("result-a-b");
  });

  test("executes 5-node mixed tree correctly", async () => {
    const runner = new PulseRunner();
    const order: string[] = [];

    runner.registerAll({
      fetch: async () => { order.push("fetch"); return { data: [1, 2, 3] }; },
      transform: async () => { order.push("transform"); return { config: true }; },
      merge: async (ctx) => {
        order.push("merge");
        return {
          fetched: ctx.parentResults.get("fetch"),
          config: ctx.parentResults.get("transform"),
        };
      },
      report: async () => { order.push("report"); return "report.pdf"; },
      notify: async () => { order.push("notify"); return "sent"; },
    });

    const execution = await runner.run({
      id: "pipeline",
      nodes: [
        { id: "fetch", name: "Fetch Data" },
        { id: "transform", name: "Transform Config" },
        { id: "merge", name: "Merge", dependsOn: ["fetch", "transform"] },
        { id: "report", name: "Generate Report", dependsOn: ["merge"] },
        { id: "notify", name: "Send Notification", dependsOn: ["report"] },
      ],
    });

    expect(execution.status).toBe("completed");
    expect(execution.results.size).toBe(5);

    // Merge must come after both fetch and transform
    const mergeIdx = order.indexOf("merge");
    expect(order.indexOf("fetch")).toBeLessThan(mergeIdx);
    expect(order.indexOf("transform")).toBeLessThan(mergeIdx);

    // Report after merge, notify after report
    expect(order.indexOf("report")).toBeGreaterThan(mergeIdx);
    expect(order.indexOf("notify")).toBeGreaterThan(order.indexOf("report"));
  });

  test("parallel nodes start within 10ms of each other", async () => {
    const runner = new PulseRunner();
    const startTimes: Record<string, number> = {};

    runner.registerAll({
      a: async () => { startTimes.a = Date.now(); await Bun.sleep(50); return "a"; },
      b: async () => { startTimes.b = Date.now(); await Bun.sleep(50); return "b"; },
      c: async () => "c",
    });

    await runner.run({
      id: "parallel",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C", dependsOn: ["a", "b"] },
      ],
    });

    const diff = Math.abs(startTimes.a - startTimes.b);
    expect(diff).toBeLessThan(10);
  });

  test("failed node skips subtree after retry exhaustion", async () => {
    const runner = new PulseRunner();
    runner.registerAll({
      a: async () => { throw new Error("fail"); },
      b: async () => "b",
      c: async () => "c",
    });

    const execution = await runner.run({
      id: "fail-tree",
      nodes: [
        { id: "a", name: "A", retries: 1 },
        { id: "b", name: "B", dependsOn: ["a"] },
        { id: "c", name: "C" },
      ],
    });

    expect(execution.status).toBe("failed");
    expect(execution.results.get("a")?.status).toBe("failed");
    expect(execution.results.get("b")?.status).toBe("skipped");
    expect(execution.results.get("c")?.status).toBe("done");
  });

  test("parent results accessible to child nodes", async () => {
    const runner = new PulseRunner();
    runner.registerAll({
      parent: async () => ({ key: "value" }),
      child: async (ctx) => ctx.parentResults.get("parent"),
    });

    const execution = await runner.run({
      id: "ctx-test",
      nodes: [
        { id: "parent", name: "Parent" },
        { id: "child", name: "Child", dependsOn: ["parent"] },
      ],
    });

    expect(execution.results.get("child")?.result).toEqual({ key: "value" });
  });

  test("emits events in correct sequence", async () => {
    const runner = new PulseRunner();
    const events: string[] = [];

    runner.on("event", (e: PulseEvent) => {
      events.push(`${e.type}:${("nodeId" in e ? e.nodeId : e.treeId)}`);
    });

    runner.registerAll({
      a: async () => "a",
      b: async () => "b",
    });

    await runner.run({
      id: "events-test",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B", dependsOn: ["a"] },
      ],
    });

    expect(events).toContain("node-start:a");
    expect(events).toContain("node-complete:a");
    expect(events).toContain("node-start:b");
    expect(events).toContain("node-complete:b");
    expect(events).toContain("tree-complete:events-test");

    // a completes before b starts
    const aComplete = events.indexOf("node-complete:a");
    const bStart = events.indexOf("node-start:b");
    expect(aComplete).toBeLessThan(bStart);
  });

  test("validates tree before execution", async () => {
    const runner = new PulseRunner();
    runner.register("a", async () => "a");

    await expect(
      runner.run({
        id: "cycle",
        nodes: [
          { id: "a", name: "A", dependsOn: ["b"] },
          { id: "b", name: "B", dependsOn: ["a"] },
        ],
      })
    ).rejects.toThrow("validation failed");
  });

  test("register and registerAll work", () => {
    const runner = new PulseRunner();
    runner.register("a", async () => 1);
    runner.registerAll({ b: async () => 2, c: async () => 3 });
    // No assertion needed — just verifying no throws
  });

  test("getExecution returns undefined before run", () => {
    const runner = new PulseRunner();
    expect(runner.getExecution()).toBeUndefined();
  });

  test("getResult returns undefined for unknown node", () => {
    const runner = new PulseRunner();
    expect(runner.getResult("nonexistent")).toBeUndefined();
  });

  test("defaultRetries option applies to nodes without explicit retries", async () => {
    let attempts = 0;
    const runner = new PulseRunner({ defaultRetries: 3 });
    runner.register("a", async () => {
      attempts++;
      if (attempts < 4) throw new Error("fail");
      return "ok";
    });

    const execution = await runner.run({
      id: "defaults",
      nodes: [{ id: "a", name: "A" }],
    });

    expect(execution.status).toBe("completed");
    expect(execution.results.get("a")?.attempts).toBe(4); // 1 initial + 3 retries
  });

  test("defaultTimeout option applies to nodes without explicit timeout", async () => {
    const runner = new PulseRunner({ defaultTimeout: 100 });
    runner.register("a", async () => {
      await Bun.sleep(5000);
      return "should not reach";
    });

    const execution = await runner.run({
      id: "timeout-default",
      nodes: [{ id: "a", name: "A", retries: 0 }],
    });

    expect(execution.status).toBe("failed");
    expect(execution.results.get("a")?.error?.message).toContain("Timeout");
  });

  test("explicit node retries override defaultRetries", async () => {
    let attempts = 0;
    const runner = new PulseRunner({ defaultRetries: 5 });
    runner.register("a", async () => {
      attempts++;
      throw new Error("fail");
    });

    const execution = await runner.run({
      id: "override",
      nodes: [{ id: "a", name: "A", retries: 1 }],
    });

    expect(execution.status).toBe("failed");
    expect(attempts).toBe(2); // 1 initial + 1 retry (not 6)
  });
});
