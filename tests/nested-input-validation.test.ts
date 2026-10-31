import { expect, test } from "bun:test";
import { validatePipeline, type CatalogEntry } from "../src/index";

const catalog: CatalogEntry[] = [
  { name: "A_FIRST", description: "sentinel", input: {}, output: { first: { type: "string" } } },
  { name: "A_NEEDS", description: "needs a field", input: { missing: { type: "string", required: true } }, output: {} },
  { name: "A_WRITES", description: "produces a field", input: {}, output: { missing: { type: "string" } } },
  { name: "A_ITEM", description: "uses an item", input: { item: { type: "object", required: true } }, output: {} },
  { name: "A_ACC", description: "uses an accumulator", input: { acc: { type: "object", required: true } }, output: {} },
];
const flow = (step: string) => `name: F_NESTED\nactions:\n  - A_FIRST # sovereignty: D, residency: CH\n${step}`;

test("missing required input inside retry is a validation failure before execution", () => {
  const result = validatePipeline(flow("  - retry: # sovereignty: D, residency: CH\n      attempts: 1\n      actions: [A_NEEDS]\n"), catalog);
  expect(result.valid).toBe(false);
  expect(result.findings).toContainEqual(expect.objectContaining({ rule: "missing-input", step: 1, message: expect.stringContaining("missing") }));
});

test("nested retry output is available to a later action", () => {
  const result = validatePipeline(flow("  - retry: # sovereignty: D, residency: CH\n      attempts: 1\n      actions: [A_WRITES]\n  - A_NEEDS # sovereignty: D, residency: CH\n"), catalog);
  expect(result.findings).toEqual([]);
});

test.each([
  "  - map: # sovereignty: D, residency: CH\n      over: items\n      as: item\n      collect: result\n      actions: [A_NEEDS]\n",
  "  - filter: # sovereignty: D, residency: CH\n      over: items\n      as: item\n      collect: result\n      keep_field: keep\n      actions: [A_NEEDS]\n",
  "  - reduce: # sovereignty: D, residency: CH\n      over: items\n      init: {}\n      item_as: item\n      acc_as: acc\n      collect: result\n      actions: [A_NEEDS]\n",
])("collection child missing input is refused: %s", (step) => {
  expect(validatePipeline(flow(step), catalog, { initialFields: ["items"] }).valid).toBe(false);
});

test("collection children receive their scoped bindings but do not leak child output", () => {
  const map = "  - map: # sovereignty: D, residency: CH\n      over: items\n      as: item\n      collect: mapped\n      actions: [A_ITEM, A_WRITES]\n";
  expect(validatePipeline(flow(map), catalog, { initialFields: ["items"] }).valid).toBe(true);
  expect(validatePipeline(flow(map + "  - A_NEEDS # sovereignty: D, residency: CH\n"), catalog, { initialFields: ["items"] }).valid).toBe(false);
  const reduce = "  - reduce: # sovereignty: D, residency: CH\n      over: items\n      init: {}\n      item_as: item\n      acc_as: acc\n      collect: result\n      actions: [A_ITEM, A_ACC]\n";
  expect(validatePipeline(flow(reduce), catalog, { initialFields: ["items"] }).valid).toBe(true);
});

test("parallel branches validate independently and never satisfy each other's required inputs", () => {
  const parallel = "  - parallel: # sovereignty: D, residency: CH\n      branches:\n        writer:\n          actions: [A_WRITES]\n        reader:\n          actions: [A_NEEDS]\n";
  expect(validatePipeline(flow(parallel), catalog).valid).toBe(false);
  expect(validatePipeline(flow(parallel), catalog, { initialFields: ["missing"] }).valid).toBe(true);
});
