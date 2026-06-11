/**
 * P-800 — validateFlow + buildCatalog (examples/soc-demo).
 * ISC-1..10 of the SOC demo plan (ISA.md, slug 2026-06-11-pulse-soc-demo-composer).
 */

import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFlow, type CatalogEntry } from "../examples/soc-demo/lib/validate-flow";
import { buildCatalog } from "../examples/soc-demo/lib/catalog";

const here = dirname(fileURLToPath(import.meta.url));
const blocksDir = join(here, "..", "examples", "soc-demo", "blocks");

const CATALOG: CatalogEntry[] = [
  {
    name: "A_FETCH_HIBP",
    description: "breach check",
    input: { email: { type: "string", required: true } },
    output: { breaches: { type: "array" } },
  },
  {
    name: "A_LOOKUP_OWNER",
    description: "IP to OU/contact",
    input: { breaches: { type: "array", required: true } },
    output: { owner: { type: "object" } },
  },
  {
    name: "A_NOTIFY_MATTERMOST",
    description: "post to MM",
    input: { owner: { type: "object", required: false } },
    output: { mattermost: { type: "object" } },
  },
];

const VALID_FLOW = `name: F_CRED_LEAK
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  - A_LOOKUP_OWNER  # sovereignty: D, residency: CH
  - A_NOTIFY_MATTERMOST  # sovereignty: D, residency: CH
`;

describe("validateFlow — happy path", () => {
  test("valid flow passes with extracted annotations", () => {
    const result = validateFlow(VALID_FLOW, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.annotations).toHaveLength(3);
    expect(result.annotations[0]).toEqual({
      index: 0,
      label: "A_FETCH_HIBP",
      sovereignty: "D",
      residency: "CH",
    });
  });

  test("annotation on comment line above the step also counts", () => {
    const flow = `name: F_X
actions:
  # sovereignty: A, residency: EU
  - A_FETCH_HIBP
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(true);
    expect(result.annotations[0]?.sovereignty).toBe("A");
    expect(result.annotations[0]?.residency).toBe("EU");
  });

  test("TODO(human) comment lines do not invalidate the flow (ISC-6)", () => {
    const flow = `name: F_X
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  # TODO(human): regulator queue handoff is not representable yet
  - A_NOTIFY_MATTERMOST  # sovereignty: D, residency: CH
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(true);
  });

  test("agent and gate steps need annotations but no catalog entry", () => {
    const flow = `name: F_X
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  - agent:  # sovereignty: A, residency: CH
      name: triage
      capability: soc.triage.email
      prompt: "Triage {{breaches}}"
  - gate:  # sovereignty: H, residency: CH
      name: analyst
      prompt: "Block or accept?"
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(true);
    expect(result.annotations.map((a) => a.label)).toEqual(["A_FETCH_HIBP", "agent", "gate"]);
    expect(result.annotations.map((a) => a.sovereignty)).toEqual(["D", "A", "H"]);
  });
});

describe("validateFlow — failure modes", () => {
  test("unknown block name is rejected, finding names the block (ISC-2)", () => {
    const flow = `name: F_X
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  - A_TOTALLY_INVENTED  # sovereignty: D, residency: CH
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(false);
    const finding = result.findings.find((f) => f.rule === "unknown-block");
    expect(finding?.message).toContain("A_TOTALLY_INVENTED");
    expect(finding?.step).toBe(1);
  });

  test("unknown block nested inside a map sub-pipeline is rejected", () => {
    const flow = `name: F_X
actions:
  - map:  # sovereignty: D, residency: CH
      over: breaches
      as: breach
      collect: results
      actions:
        - A_INVENTED_INNER
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["breaches"] });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === "unknown-block" && f.message.includes("A_INVENTED_INNER"))).toBe(true);
  });

  test("missing required input is rejected (ISC-3)", () => {
    const flow = `name: F_X
actions:
  - A_LOOKUP_OWNER  # sovereignty: D, residency: CH
`;
    // breaches is required but neither initial nor produced by a prior step
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(false);
    const finding = result.findings.find((f) => f.rule === "missing-input");
    expect(finding?.message).toContain("breaches");
  });

  test("required input satisfied by a prior step's output passes", () => {
    const flow = `name: F_X
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  - A_LOOKUP_OWNER  # sovereignty: D, residency: CH
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(true);
  });

  test("missing sovereignty annotation is rejected (ISC-4)", () => {
    const flow = `name: F_X
actions:
  - A_FETCH_HIBP
`;
    const result = validateFlow(flow, CATALOG, { initialFields: ["email"] });
    expect(result.valid).toBe(false);
    const finding = result.findings.find((f) => f.rule === "missing-annotation");
    expect(finding?.step).toBe(0);
    expect(finding?.message).toContain("A_FETCH_HIBP");
  });

  test("unparseable YAML yields parse-error, not a throw", () => {
    const result = validateFlow("actions:\n  - [unclosed", CATALOG);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.rule).toBe("parse-error");
  });

  test("empty actions list yields parse-error", () => {
    const result = validateFlow("name: F_X\nactions: []\n", CATALOG);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.rule).toBe("parse-error");
  });
});

describe("buildCatalog (ISC-8)", () => {
  test("scans blocks dir and returns sorted entries with descriptions", async () => {
    const catalog = await buildCatalog(blocksDir);
    expect(catalog.length).toBeGreaterThanOrEqual(1);
    const validateEntry = catalog.find((e) => e.name === "A_VALIDATE_FLOW");
    expect(validateEntry).toBeDefined();
    expect(validateEntry?.description.length).toBeGreaterThan(0);
    const names = catalog.map((e) => e.name);
    expect([...names].sort()).toEqual(names);
  });
});

describe("A_VALIDATE_FLOW block wrapper (ISC-9)", () => {
  test("wraps the pure core and returns validation in payload", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_VALIDATE_FLOW/action");
    const result = (await mod.default.execute(
      {
        flow_yaml: VALID_FLOW,
        catalog: CATALOG,
        initial_fields: ["email"],
        scenario: "credential leak",
      },
      { capabilities: {}, env: {}, meta: { actionName: "A_VALIDATE_FLOW", startedAt: new Date().toISOString(), mode: "local" } } as never,
    )) as Record<string, unknown>;
    expect((result.validation as { valid: boolean }).valid).toBe(true);
    // passthrough preserved
    expect(result.scenario).toBe("credential leak");
  });
});
