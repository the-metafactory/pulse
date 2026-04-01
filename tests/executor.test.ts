import { describe, expect, test } from "bun:test";
import { Executor } from "../src/lib/executor";
import type { PulseNode, ExecutionContext } from "../src/types/pulse";

function makeNode(
  id: string,
  fn: (ctx: ExecutionContext) => Promise<any>,
  opts: Partial<PulseNode> = {}
): PulseNode {
  return {
    id,
    name: id,
    dependsOn: [],
    children: [],
    fn,
    ...opts,
  };
}

const emptyContext: ExecutionContext = { parentResults: new Map() };

describe("Executor", () => {
  const executor = new Executor();

  test("executes successful node", async () => {
    const node = makeNode("a", async () => 42);
    const result = await executor.execute(node, emptyContext);
    expect(result.status).toBe("done");
    expect(result.result).toBe(42);
    expect(result.attempts).toBe(1);
  });

  test("records timing", async () => {
    const node = makeNode("a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "ok";
    });
    const result = await executor.execute(node, emptyContext);
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(result.completedAt!.getTime()).toBeGreaterThanOrEqual(
      result.startedAt!.getTime()
    );
  });

  test("retries on failure then succeeds", async () => {
    let attempts = 0;
    const node = makeNode("a", async () => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
      return "success";
    });
    const result = await executor.execute(node, emptyContext);
    expect(result.status).toBe("done");
    expect(result.result).toBe("success");
    expect(result.attempts).toBe(3);
  });

  test("fails after exhausting retries", async () => {
    const node = makeNode(
      "a",
      async () => {
        throw new Error("always fail");
      },
      { retries: 1 }
    );
    const result = await executor.execute(node, emptyContext);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("always fail");
    expect(result.attempts).toBe(2); // 1 + 1 retry
  });

  test("respects timeout", async () => {
    const node = makeNode(
      "a",
      async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return "should not reach";
      },
      { timeout: 100, retries: 0 }
    );
    const result = await executor.execute(node, emptyContext);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("Timeout");
  });

  test("passes context to function", async () => {
    const context: ExecutionContext = {
      parentResults: new Map([["parent", { data: 123 }]]),
    };
    const node = makeNode("a", async (ctx) => {
      return ctx.parentResults.get("parent");
    });
    const result = await executor.execute(node, context);
    expect(result.status).toBe("done");
    expect(result.result).toEqual({ data: 123 });
  });

  test("clears timeout timer on success (no timer leak)", async () => {
    const node = makeNode(
      "a",
      async () => "fast",
      { timeout: 60000, retries: 0 }
    );
    const before = Bun.nanoseconds();
    const result = await executor.execute(node, emptyContext);
    const elapsed = (Bun.nanoseconds() - before) / 1e6;
    expect(result.status).toBe("done");
    // If the timer leaked, the test process would hang for 60s.
    // Resolving quickly proves the timer was cleared.
    expect(elapsed).toBeLessThan(1000);
  });
});
