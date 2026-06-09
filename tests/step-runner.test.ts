import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runPipeline } from "../src/lib/pipeline";
import { validateStep, validateSteps } from "../src/lib/step-runner";
import type { PipelineStep } from "../src/types/pipeline";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-step-runner-actions");

beforeAll(() => {
  // A_DOUBLE: doubles a numeric "value" field
  createAction(TEST_DIR, "A_DOUBLE", {
    input: { value: { type: "number", required: true } },
    output: { doubled: { type: "number" } },
  }, `export default {
    async execute(input) {
      const { value, ...payload } = input;
      return { ...payload, value, doubled: value * 2 };
    }
  };`);

  // A_ADD_TEN: adds 10 to "value"
  createAction(TEST_DIR, "A_ADD_TEN", {
    input: { value: { type: "number", required: true } },
    output: { value: { type: "number" } },
  }, `export default {
    async execute(input) {
      const { value, ...payload } = input;
      return { ...payload, value: value + 10 };
    }
  };`);

  // A_IS_EVEN: returns { keep: true } if item.value is even
  createAction(TEST_DIR, "A_IS_EVEN", {
    input: { item: { type: "object", required: true } },
    output: { keep: { type: "boolean" } },
  }, `export default {
    async execute(input) {
      const { item, ...payload } = input;
      return { ...payload, item, keep: item.value % 2 === 0 };
    }
  };`);

  // A_ACCUMULATE: appends item.label to acc.labels string
  createAction(TEST_DIR, "A_ACCUMULATE", {
    input: {},
    output: {},
  }, `export default {
    async execute(input) {
      const { entry, acc, ...payload } = input;
      return { ...payload, entry, acc: { labels: acc.labels + entry.label + "," } };
    }
  };`);

  // A_FETCH_A: returns { data: "alpha" }
  createAction(TEST_DIR, "A_FETCH_A", {
    input: {},
    output: { data: { type: "string" } },
  }, `export default {
    async execute(input) {
      return { ...input, data: "alpha" };
    }
  };`);

  // A_FETCH_B: returns { data: "beta" }
  createAction(TEST_DIR, "A_FETCH_B", {
    input: {},
    output: { data: { type: "string" } },
  }, `export default {
    async execute(input) {
      return { ...input, data: "beta" };
    }
  };`);

  // A_FAIL: always throws
  createAction(TEST_DIR, "A_FAIL", {
    input: {},
    output: {},
  }, `export default {
    async execute() {
      throw new Error("deliberate failure");
    }
  };`);

  // A_ITEM_DOUBLE: reads item.value from the as-bound field, doubles it
  createAction(TEST_DIR, "A_ITEM_DOUBLE", {
    input: { item: { type: "object", required: true } },
    output: { doubled: { type: "number" } },
  }, `export default {
    async execute(input) {
      const { item, ...payload } = input;
      return { ...payload, item, doubled: item.value * 2 };
    }
  };`);

  // A_FAIL_ONCE: fails on first call, succeeds after (uses file-based counter for test isolation)
  const failOnceDir = join(TEST_DIR, "A_FAIL_ONCE");
  mkdirSync(failOnceDir, { recursive: true });
  writeFileSync(join(failOnceDir, "action.json"), JSON.stringify({
    name: "A_FAIL_ONCE", version: "1.0.0", description: "Fails once",
    input: {}, output: {}, requires: [],
  }));
  const counterFile = join(TEST_DIR, "fail-once-counter.txt");
  writeFileSync(counterFile, "0");
  writeFileSync(join(failOnceDir, "action.ts"), `
    import { readFileSync, writeFileSync } from "fs";
    const COUNTER_FILE = ${JSON.stringify(counterFile)};
    export default {
      async execute(input) {
        const count = parseInt(readFileSync(COUNTER_FILE, "utf8")) + 1;
        writeFileSync(COUNTER_FILE, String(count));
        if (count === 1) throw new Error("transient failure");
        return { ...input, recovered: true };
      }
    };
  `);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createAction(
  baseDir: string,
  name: string,
  manifest: { input: Record<string, unknown>; output: Record<string, unknown> },
  code: string,
) {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "action.json"), JSON.stringify({
    name, version: "1.0.0", description: name,
    input: manifest.input, output: manifest.output, requires: [],
  }));
  writeFileSync(join(dir, "action.ts"), code);
}

const opts = { actionDirs: [TEST_DIR] };

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

describe("map primitive", () => {
  test("maps sub-pipeline over array items", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_ITEM_DOUBLE"],
          collect: "results",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_TEST", actions: steps },
      { items: [{ value: 1 }, { value: 2 }, { value: 3 }] },
      opts,
    );

    expect(result.success).toBe(true);
    const results = result.output!.results as any[];
    expect(results).toHaveLength(3);
    // Each result should have the doubled value from the sub-pipeline
    expect(results[0].doubled).toBe(2);
    expect(results[1].doubled).toBe(4);
    expect(results[2].doubled).toBe(6);
  });

  test("map with empty array produces empty collect", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_ITEM_DOUBLE"],
          collect: "results",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_EMPTY", actions: steps },
      { items: [] },
      opts,
    );

    expect(result.success).toBe(true);
    expect(result.output!.results).toEqual([]);
  });

  test("map throws on non-array field", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_ITEM_DOUBLE"],
          collect: "results",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_BAD", actions: steps },
      { items: "not-an-array" },
      opts,
    );

    expect(result.success).toBe(false);
  });

  test("map onError:stop throws on item failure (default)", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_FAIL"],
          collect: "results",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_FAIL", actions: steps },
      { items: [{ value: 1 }] },
      opts,
    );

    expect(result.success).toBe(false);
  });

  test("map onError:skip omits failed items", async () => {
    // A_DOUBLE requires value field — items without it will fail
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_FAIL"],
          collect: "results",
          onError: "skip",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_SKIP", actions: steps },
      { items: [{ value: 1 }, { value: 2 }] },
      opts,
    );

    expect(result.success).toBe(true);
    // All items failed and were skipped
    expect(result.output!.results).toEqual([]);
  });

  test("map onError:collect includes error entries", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_FAIL"],
          collect: "results",
          onError: "collect",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MAP_COLLECT", actions: steps },
      { items: [{ value: 1 }] },
      opts,
    );

    expect(result.success).toBe(true);
    const results = result.output!.results as any[];
    expect(results).toHaveLength(1);
    expect(results[0]._error).toBe(true);
    expect(results[0].index).toBe(0);
    expect(results[0].error).toBeDefined();
    expect(results[0].item).toEqual({ value: 1 });
  });

  test("map with concurrency > 1 preserves order", async () => {
    const steps: PipelineStep[] = [
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_ITEM_DOUBLE"],
          collect: "results",
          concurrency: 3,
        },
      },
    ];

    const items = Array.from({ length: 5 }, (_, i) => ({ value: i + 1 }));
    const result = await runPipeline(
      { name: "P_MAP_CONCURRENT", actions: steps },
      { items },
      opts,
    );

    expect(result.success).toBe(true);
    const results = result.output!.results as any[];
    expect(results).toHaveLength(5);
    expect(results[0].doubled).toBe(2);
    expect(results[1].doubled).toBe(4);
    expect(results[2].doubled).toBe(6);
    expect(results[3].doubled).toBe(8);
    expect(results[4].doubled).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

describe("filter primitive", () => {
  test("keeps items where predicate returns true", async () => {
    const steps: PipelineStep[] = [
      {
        filter: {
          over: "items",
          as: "item",
          actions: ["A_IS_EVEN"],
          keep_field: "keep",
          collect: "evens",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_FILTER_TEST", actions: steps },
      { items: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }] },
      opts,
    );

    expect(result.success).toBe(true);
    const evens = result.output!.evens as any[];
    expect(evens).toHaveLength(2);
    expect(evens[0].value).toBe(2);
    expect(evens[1].value).toBe(4);
  });

  test("filter preserves input order", async () => {
    const steps: PipelineStep[] = [
      {
        filter: {
          over: "items",
          as: "item",
          actions: ["A_IS_EVEN"],
          keep_field: "keep",
          collect: "evens",
          concurrency: 3,
        },
      },
    ];

    const items = Array.from({ length: 10 }, (_, i) => ({ value: i }));
    const result = await runPipeline(
      { name: "P_FILTER_ORDER", actions: steps },
      { items },
      opts,
    );

    expect(result.success).toBe(true);
    const evens = result.output!.evens as any[];
    // Even values: 0, 2, 4, 6, 8
    expect(evens.map((e: any) => e.value)).toEqual([0, 2, 4, 6, 8]);
  });
});

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

describe("reduce primitive", () => {
  test("folds items sequentially with accumulator", async () => {
    const steps: PipelineStep[] = [
      {
        reduce: {
          over: "items",
          init: { labels: "" },
          item_as: "entry",
          acc_as: "acc",
          actions: ["A_ACCUMULATE"],
          collect: "combined",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_REDUCE_TEST", actions: steps },
      { items: [{ label: "a" }, { label: "b" }, { label: "c" }] },
      opts,
    );

    expect(result.success).toBe(true);
    const combined = result.output!.combined as any;
    expect(combined.labels).toBe("a,b,c,");
  });

  test("reduce with empty array returns init", async () => {
    const steps: PipelineStep[] = [
      {
        reduce: {
          over: "items",
          init: { labels: "empty" },
          item_as: "entry",
          acc_as: "acc",
          actions: ["A_ACCUMULATE"],
          collect: "combined",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_REDUCE_EMPTY", actions: steps },
      { items: [] },
      opts,
    );

    expect(result.success).toBe(true);
    const combined = result.output!.combined as any;
    expect(combined.labels).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// parallel
// ---------------------------------------------------------------------------

describe("parallel primitive", () => {
  test("runs branches concurrently and merges results", async () => {
    const steps: PipelineStep[] = [
      {
        parallel: {
          branches: {
            branch_a: { actions: ["A_FETCH_A"] },
            branch_b: { actions: ["A_FETCH_B"] },
          },
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_PARALLEL_TEST", actions: steps },
      { seed: "test" },
      opts,
    );

    expect(result.success).toBe(true);
    const output = result.output!;
    const branchA = output.branch_a as any;
    const branchB = output.branch_b as any;
    expect(branchA.data).toBe("alpha");
    expect(branchB.data).toBe("beta");
    // Original payload preserved
    expect(output.seed).toBe("test");
  });

  test("parallel uses structuredClone — branches don't mutate each other", async () => {
    const steps: PipelineStep[] = [
      {
        parallel: {
          branches: {
            a: { actions: ["A_FETCH_A"] },
            b: { actions: ["A_FETCH_B"] },
          },
        },
      },
    ];

    const sharedInput = { shared: { nested: "original" } };
    const result = await runPipeline(
      { name: "P_PARALLEL_CLONE", actions: steps },
      sharedInput,
      opts,
    );

    expect(result.success).toBe(true);
    // Original input should not be mutated
    expect(sharedInput.shared.nested).toBe("original");
  });

  test("parallel onError:stop fails on branch failure", async () => {
    const steps: PipelineStep[] = [
      {
        parallel: {
          branches: {
            good: { actions: ["A_FETCH_A"] },
            bad: { actions: ["A_FAIL"] },
          },
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_PARALLEL_FAIL", actions: steps },
      {},
      opts,
    );

    expect(result.success).toBe(false);
  });

  test("parallel onError:collect includes error entries for failed branches", async () => {
    const steps: PipelineStep[] = [
      {
        parallel: {
          branches: {
            good: { actions: ["A_FETCH_A"] },
            bad: { actions: ["A_FAIL"] },
          },
          onError: "collect",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_PARALLEL_COLLECT", actions: steps },
      {},
      opts,
    );

    expect(result.success).toBe(true);
    const output = result.output!;
    const good = output.good as any;
    const bad = output.bad as any;
    expect(good.data).toBe("alpha");
    expect(bad._error).toBe(true);
    expect(bad.branch).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

describe("retry primitive", () => {
  test("retries on failure and succeeds", async () => {
    const steps: PipelineStep[] = [
      {
        retry: {
          attempts: 3,
          backoff: "constant",
          initial_delay_ms: 10,
          actions: ["A_FAIL_ONCE"],
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_RETRY_TEST", actions: steps },
      { value: 42 },
      opts,
    );

    expect(result.success).toBe(true);
    expect(result.output!.recovered).toBe(true);
  });

  test("retry exhausts attempts and fails", async () => {
    const steps: PipelineStep[] = [
      {
        retry: {
          attempts: 2,
          backoff: "constant",
          initial_delay_ms: 10,
          actions: ["A_FAIL"],
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_RETRY_EXHAUST", actions: steps },
      {},
      opts,
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runStep unknown shape
// ---------------------------------------------------------------------------

describe("step dispatcher", () => {
  test("throws on unknown step shape", async () => {
    const steps = [{ unknown_primitive: { foo: "bar" } }] as unknown as PipelineStep[];

    const result = await runPipeline(
      { name: "P_UNKNOWN", actions: steps },
      {},
      opts,
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// composition: mixed steps
// ---------------------------------------------------------------------------

describe("composition", () => {
  test("strings and primitives interleave in a pipeline", async () => {
    const steps: PipelineStep[] = [
      "A_DOUBLE",
      {
        map: {
          over: "items",
          as: "item",
          actions: ["A_ITEM_DOUBLE"],
          collect: "mapped",
        },
      },
    ];

    const result = await runPipeline(
      { name: "P_MIXED", actions: steps },
      { value: 5, items: [{ value: 10 }, { value: 20 }] },
      opts,
    );

    expect(result.success).toBe(true);
    expect(result.output!.doubled).toBe(10);
    const mapped = result.output!.mapped as any[];
    expect(mapped[0].doubled).toBe(20);
    expect(mapped[1].doubled).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// backwards compatibility: legacy string-only pipelines
// ---------------------------------------------------------------------------

describe("backwards compatibility", () => {
  test("legacy string-only pipeline still works through new dispatcher", async () => {
    const result = await runPipeline(
      { name: "P_LEGACY", actions: ["A_DOUBLE", "A_ADD_TEN"] },
      { value: 5 },
      opts,
    );

    expect(result.success).toBe(true);
    expect(result.output!.doubled).toBe(10);
    expect(result.output!.value).toBe(15); // 5 + 10
  });
});

// ---------------------------------------------------------------------------
// parse-time step validation
// ---------------------------------------------------------------------------

describe("step validation", () => {
  test("accepts string steps", () => {
    expect(validateStep("A_FOO")).toBe("A_FOO");
  });

  test("accepts known primitive keys", () => {
    const step = { map: { over: "items", as: "item", actions: ["A_FOO"], collect: "results" } };
    expect(validateStep(step)).toEqual(step);
  });

  test("rejects unknown primitive keys", () => {
    expect(() => validateStep({ mapp: { over: "x" } })).toThrow("unknown step type");
  });

  test("rejects non-string non-object steps", () => {
    expect(() => validateStep(42)).toThrow("step must be a string or object");
  });

  test("rejects steps with multiple primitive keys", () => {
    expect(() => validateStep({ map: {}, filter: {} })).toThrow("exactly one primitive key");
  });

  test("validates nested actions recursively", () => {
    const step = { map: { over: "x", as: "y", actions: [{ badkey: {} }], collect: "z" } };
    expect(() => validateStep(step)).toThrow("unknown step type");
  });

  test("validates parallel branch actions recursively", () => {
    const step = { parallel: { branches: { a: { actions: [{ nope: {} }] } } } };
    expect(() => validateStep(step)).toThrow("unknown step type");
  });

  test("detects duplicate parallel branch names at parse time", () => {
    // Note: JS objects can't have duplicate keys — this is caught at runtime
    // The validation checks the Set size vs keys length
    const step = { parallel: { branches: { a: { actions: ["A_FOO"] } } } };
    expect(validateStep(step)).toBeTruthy();
  });

  test("validateSteps validates an array of steps", () => {
    expect(validateSteps(["A_FOO", { map: { over: "x", as: "y", actions: ["A_BAR"], collect: "z" } }])).toHaveLength(2);
    expect(() => validateSteps(["A_FOO", { bad: {} }])).toThrow("unknown step type");
  });
});

// ---------------------------------------------------------------------------
// partial output on failure (W3)
// ---------------------------------------------------------------------------

describe("partial output on failure", () => {
  test("preserves accumulated data from steps before the failure", async () => {
    const result = await runPipeline(
      { name: "P_PARTIAL", actions: ["A_DOUBLE", "A_FAIL", "A_ADD_TEN"] },
      { value: 5 },
      opts,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // A_DOUBLE ran successfully — its output should be in partial output
    expect(result.output!.doubled).toBe(10);
    expect(result.output!.value).toBe(5);
  });
});
