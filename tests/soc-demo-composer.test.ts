/**
 * P-803/P-804 — composer core + mermaid render.
 * ISC-28..34 of the SOC demo plan (ISA.md, slug 2026-06-11-pulse-soc-demo-composer).
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compose,
  composeTier,
  extractFence,
  loadSystemPrompt,
  SELF_DISCLOSURE,
  type ComposerLLM,
} from "../examples/soc-demo/composer/compose";
import type { LLMOptions } from "../src/types/action";
import { renderMermaid } from "../examples/soc-demo/composer/mermaid";
import type { CatalogEntry } from "../examples/soc-demo/lib/validate-pipeline";

const here = dirname(fileURLToPath(import.meta.url));

const CATALOG: CatalogEntry[] = [
  {
    name: "A_FETCH_HIBP",
    description: "breach check",
    input: { email: { type: "string", required: true } },
    output: { hibp: { type: "object" } },
  },
  {
    name: "A_LOOKUP_OWNER",
    description: "owner lookup",
    input: {},
    output: { owner: { type: "object" } },
  },
];

const GOOD_RESPONSE = `Here is the flow.

\`\`\`yaml
name: F_CRED_LEAK
actions:
  - A_FETCH_HIBP  # sovereignty: D, residency: CH
  - A_LOOKUP_OWNER  # sovereignty: D, residency: CH
\`\`\`

\`\`\`mermaid
flowchart TD
  A[A_FETCH_HIBP\\n(D)] --> B[A_LOOKUP_OWNER\\n(D)]
\`\`\`

Email in, owner notification out; the analyst gates nothing in this short flow.`;

const BAD_RESPONSE = `\`\`\`yaml
name: F_BAD
actions:
  - A_INVENTED_BLOCK  # sovereignty: D, residency: CH
\`\`\`

\`\`\`mermaid
flowchart TD
  A[A_INVENTED_BLOCK]
\`\`\`

Made up flow.`;

function mockLlm(responses: string[]): { llm: ComposerLLM; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const llm: ComposerLLM = async (prompt) => {
    calls.push(prompt);
    const text = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return { text };
  };
  return { llm, calls };
}

describe("compose (ISC-29/30)", () => {
  test("valid first emission returns yaml + mermaid + summary + annotations", async () => {
    const { llm, calls } = mockLlm([GOOD_RESPONSE]);
    const result = await compose("credential leak", CATALOG, llm, {
      initialFields: ["email", "scenario"],
      systemPrompt: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.yaml).toContain("A_FETCH_HIBP");
    expect(result.mermaid).toContain("flowchart TD");
    expect(result.summary).toContain("Email in");
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0]?.sovereignty).toBe("D");
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("invalid-then-valid: re-prompts with validator findings (ISC-30)", async () => {
    const { llm, calls } = mockLlm([BAD_RESPONSE, GOOD_RESPONSE]);
    const result = await compose("credential leak", CATALOG, llm, {
      initialFields: ["email", "scenario"],
      systemPrompt: "test",
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    // The re-prompt carries the validator's findings
    expect(calls[1]).toContain("A_INVENTED_BLOCK");
    expect(calls[1]).toContain("unknown-block");
  });

  test("always-invalid: max 2 retries then closest-match fallback (ISC-30)", async () => {
    const CLOSEST = "Closest I have is `A_FETCH_HIBP`; the gap is *no registrar block*. Pivot to *credential leak*?";
    const { llm, calls } = mockLlm([BAD_RESPONSE, BAD_RESPONSE, BAD_RESPONSE, CLOSEST]);
    const result = await compose("brand abuse", CATALOG, llm, { systemPrompt: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("no-match");
    if (result.kind !== "no-match") throw new Error("unreachable");
    expect(result.message).toContain("Closest I have");
    // 1 initial + 2 retries + 1 fallback request
    expect(calls).toHaveLength(4);
    expect(result.attempts).toBe(4);
  });

  test("no YAML fence at all = composer chose the no-match path directly", async () => {
    const { llm } = mockLlm(["Closest I have is `A_LOOKUP_OWNER`; the gap is *no DDoS telemetry*. Pivot?"]);
    const result = await compose("ddos mitigation", CATALOG, llm, { systemPrompt: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("no-match");
  });

  test("Anti (ISC-31): invalid yaml NEVER comes back as ok — unknown blocks cannot reach execution", async () => {
    const { llm } = mockLlm([BAD_RESPONSE]);
    const result = await compose("anything", CATALOG, llm, { systemPrompt: "test", maxRetries: 0 });
    expect(result.ok).toBe(false);
  });

  test("self-disclosure constant names frontier-A (ISC-32)", () => {
    expect(SELF_DISCLOSURE).toContain("frontier-A");
  });

  test("loadSystemPrompt embeds §3 rules and the catalog (ISC-28)", async () => {
    const prompt = await loadSystemPrompt(CATALOG);
    expect(prompt).toContain("source of truth");
    expect(prompt).toContain("Closest I have is");
    expect(prompt).toContain("sovereignty: D|A|H");
    expect(prompt).toContain("frontier-A");
    expect(prompt).toContain("A_VALIDATE_FLOW");
    expect(prompt).toContain('"A_FETCH_HIBP"');
  });

  test("SYSTEM_PROMPT.md exists as a reviewable artifact (ISC-28)", () => {
    expect(existsSync(join(here, "..", "examples", "soc-demo", "composer", "SYSTEM_PROMPT.md"))).toBe(true);
  });
});

describe("extractFence", () => {
  test("pulls the first fence of a language, ignoring others", () => {
    expect(extractFence(GOOD_RESPONSE, "yaml")).toContain("F_CRED_LEAK");
    expect(extractFence(GOOD_RESPONSE, "mermaid")).toContain("flowchart");
    expect(extractFence("no fences here", "yaml")).toBeNull();
  });
});

describe("renderMermaid (ISC-33/34)", () => {
  test("failure path returns null (fallback-to-source), never throws", async () => {
    const png = await renderMermaid("flowchart TD\n A --> B", { cmd: ["false"] });
    expect(png).toBeNull();
  });

  test("nonexistent binary returns null, never throws", async () => {
    const png = await renderMermaid("flowchart TD\n A --> B", { cmd: ["definitely-not-a-real-binary-xyz"] });
    expect(png).toBeNull();
  });

  // Live render is env-gated like the other stub-safe adapters: bunx fetches
  // mermaid-cli (~network) — opt in with MERMAID_LIVE=1.
  test.if(process.env.MERMAID_LIVE === "1")("live render produces a non-empty PNG", async () => {
    const png = await renderMermaid("flowchart TD\n A[start] --> B[end]");
    expect(png).not.toBeNull();
    expect(png!.byteLength).toBeGreaterThan(1000);
  }, 60_000);
});

describe("composeTier — env-tunable, defaults to standard (Sonnet)", () => {
  const prev = process.env.PULSE_COMPOSE_TIER;
  const restore = () => {
    if (prev === undefined) delete process.env.PULSE_COMPOSE_TIER;
    else process.env.PULSE_COMPOSE_TIER = prev;
  };

  test("defaults to standard when unset or invalid", () => {
    delete process.env.PULSE_COMPOSE_TIER;
    expect(composeTier()).toBe("standard");
    process.env.PULSE_COMPOSE_TIER = "bogus";
    expect(composeTier()).toBe("standard");
    restore();
  });

  test("honours a valid override", () => {
    process.env.PULSE_COMPOSE_TIER = "smart";
    expect(composeTier()).toBe("smart");
    process.env.PULSE_COMPOSE_TIER = "fast";
    expect(composeTier()).toBe("fast");
    restore();
  });

  test("compose calls the llm at the resolved tier (default standard)", async () => {
    delete process.env.PULSE_COMPOSE_TIER;
    const tiers: Array<LLMOptions["tier"]> = [];
    const llm: ComposerLLM = async (_prompt, options) => {
      tiers.push(options?.tier);
      return { text: GOOD_RESPONSE };
    };
    await compose("credential leak", CATALOG, llm, {
      initialFields: ["email", "scenario"],
      systemPrompt: "test",
    });
    expect(tiers).toEqual(["standard"]); // not "smart" (Opus)
    restore();
  });
});
