import { describe, it, expect } from "bun:test";
import { routineContract } from "../src/lib/routine-contract";
import { proposeRoutineEdit } from "../src/lib/routine-proposal";

const yaml = "# reflex-generated-flow: test v1\nname: F_TEST\ninput: {token: secret-value}\nactions:\n  - retry:\n      attempts: 2\n      actions: [A_NOOP]\n  - agent:\n      name: review\n      capability: test.review\n      prompt: secret-prompt\n      collect: result\n";
describe("routine contract", () => {
  it("redacts undeclared values, shows nested order and edits only declared retry fields", () => {
    const before = routineContract({ yaml });
    expect(JSON.stringify(before)).not.toContain("secret");
    expect(before.view.steps.map((s) => s.action)).toEqual(["retry", "A_NOOP", "agent"]);
    const changed = routineContract({ yaml, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] });
    expect(changed.yaml).toContain("attempts: 3");
    expect(changed.yaml).toContain("secret-value");
    expect(changed.yaml).toStartWith("# reflex-generated-flow: test v1");
    expect(() => routineContract({ yaml, patches: [{ path: ["input", "token"], value: "changed" }] })).toThrow("not declared editable");
    expect(() => routineContract({ yaml, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 0 }] })).toThrow("range");
  });
  it("AI receives only declared safe parameters and cannot propose a secret-field write", async () => {
    const view = routineContract({ yaml }).view;
    let prompt = "";
    const result = await proposeRoutineEdit("use three attempts", view, async (p) => { prompt = p; return { text: JSON.stringify({ patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }) }; });
    expect(prompt).not.toContain("secret");
    expect(result.patches).toHaveLength(1);
    await expect(proposeRoutineEdit("change token", view, async () => ({ text: JSON.stringify({ patches: [{ path: ["input", "token"], value: "bad" }] }) }))).rejects.toThrow("outside");
  });
  it("uses authoritative primitive selection with metadata and preserves parallel branch connections", () => {
    const flow = "name: F_BRANCH\nextra: preserve\nactions:\n  - label: branch-metadata\n    parallel:\n      branches:\n        left:\n          actions:\n            - retry:\n                attempts: 2\n                actions: [A_LEFT]\n        right:\n          actions:\n            - map:\n                over: items\n                as: item\n                collect: results\n                actions: [A_RIGHT]\n";
    const result = routineContract({ yaml: flow });
    expect(result.view.steps.map((step) => step.action)).toEqual(["parallel", "retry", "A_LEFT", "map", "A_RIGHT"]);
    expect(result.view.steps[3]?.parameters).toContainEqual({ name: "over", kind: "binding", value: "items" });
    expect(result.view.steps[3]?.purpose).toContain("branch right");
    const edited = routineContract({ yaml: flow, patches: [{ path: ["actions", 0, "parallel", "branches", "left", "actions", 0, "retry", "attempts"], value: 4 }] });
    expect(edited.yaml).toContain("extra: preserve");
    expect(edited.yaml).toContain("label: branch-metadata");
    expect(edited.yaml).toContain("A_RIGHT");
  });
});
