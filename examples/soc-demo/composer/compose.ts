/**
 * Yarrow (Pulse Composer) core — scenario + catalog + injected LLM → { yaml, mermaid,
 * summary } with the validator-retry loop (design/soc-demo-mm-composer.md §5).
 *
 * MM-agnostic and LLM-injected: the Mattermost wiring (P-805) supplies the
 * llm capability (same signature as ActionCapabilities.llm) and posts the
 * results; tests supply mocks. The system prompt lives in SYSTEM_PROMPT.md —
 * a reviewable artifact, never inline strings.
 *
 * Fail-closed loop: every emission is checked by validatePipeline against the
 * installed catalog. Invalid → re-prompt with the validator's findings, max
 * MAX_RETRIES; exhausted → one final closest-match request (rule 2 of the
 * prompt) so the demo degrades to "the system tells me when it can't",
 * never to an invalid flow reaching execution.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMOptions, LLMResponse } from "../../../src/types/action";
import {
  validatePipeline,
  type CatalogEntry,
  type Finding,
  type StepAnnotation,
} from "../lib/validate-pipeline";

export type ComposerLLM = (prompt: string, options?: LLMOptions) => Promise<LLMResponse>;

export interface ComposeOptions {
  /** Fields present in the pipeline's initial input. Default: ["scenario"]. */
  initialFields?: string[];
  /** Validator-retry ceiling (design §5: max 2). */
  maxRetries?: number;
  /** Override the system prompt (tests). Default: SYSTEM_PROMPT.md + catalog. */
  systemPrompt?: string;
}

export type ComposeResult =
  | {
      ok: true;
      yaml: string;
      mermaid: string | null;
      summary: string;
      annotations: StepAnnotation[];
      attempts: number;
    }
  | {
      ok: false;
      kind: "no-match";
      message: string;
      attempts: number;
    }
  | {
      ok: false;
      kind: "invalid";
      findings: Finding[];
      lastYaml: string;
      attempts: number;
    };

/**
 * The composer's own sovereignty class, disclosed before any run (design
 * §3.4). The wiring posts this as part of the composer's first thread reply.
 */
export const SELF_DISCLOSURE =
  "⚖️ Yarrow (Pulse Composer) is frontier-A (text → YAML is reasoning on a frontier model). " +
  "The flows it emits can still route individual steps local-only — watch the annotations.";

const here = dirname(fileURLToPath(import.meta.url));

export async function loadSystemPrompt(catalog: CatalogEntry[]): Promise<string> {
  const template = await readFile(join(here, "SYSTEM_PROMPT.md"), "utf-8");
  return `${template}\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\`\n`;
}

/** Extract the first fenced block of the given language from LLM output. */
export function extractFence(text: string, lang: string): string | null {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
  const match = text.match(re);
  return match ? match[1]!.trimEnd() + "\n" : null;
}

/** The one-line summary: first non-empty line outside any fenced block. */
function extractSummary(text: string): string {
  const withoutFences = text.replace(/```[a-z]*\s*\n[\s\S]*?```/gi, "");
  const lines = withoutFences
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("⚖️"));
  return lines[lines.length - 1] ?? "";
}

export async function compose(
  scenario: string,
  catalog: CatalogEntry[],
  llm: ComposerLLM,
  options: ComposeOptions = {},
): Promise<ComposeResult> {
  const maxRetries = options.maxRetries ?? 2;
  const initialFields = options.initialFields ?? ["scenario"];
  const system = options.systemPrompt ?? (await loadSystemPrompt(catalog));

  let prompt = `Scenario from the audience:\n\n${scenario}\n\nCompose the pipeline.`;
  let lastYaml = "";
  let lastFindings: Finding[] = [];
  let attempts = 0;

  // 1 initial attempt + maxRetries validator-driven re-prompts
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    const response = await llm(prompt, { system, tier: "smart" });
    const text = response.text ?? "";

    const yaml = extractFence(text, "yaml");
    if (!yaml) {
      // No YAML fence AND substantive text — the composer chose the no-match
      // path (prompt rule 2). An EMPTY reply is a failure, not a pivot:
      // retry it like a validation miss instead of surfacing "" to the stage.
      if (text.trim().length > 0) {
        return { ok: false, kind: "no-match", message: text.trim(), attempts };
      }
      lastFindings = [{ rule: "parse-error", step: -1, message: "empty composer reply" }];
      prompt = `Your previous reply was empty. Emit the full response (yaml + mermaid + summary) for the scenario.`;
      continue;
    }

    const validation = validatePipeline(yaml, catalog, { initialFields });
    if (validation.valid) {
      return {
        ok: true,
        yaml,
        mermaid: extractFence(text, "mermaid"),
        summary: extractSummary(text),
        annotations: validation.annotations,
        attempts,
      };
    }

    lastYaml = yaml;
    lastFindings = validation.findings;
    const findingLines = validation.findings
      .map((f) => `- [${f.rule}] step ${f.step}: ${f.message}`)
      .join("\n");
    // Include the failed YAML — each llm() call is stateless, so without it
    // the model would be fixing findings against a flow it can no longer see.
    prompt =
      `Your previous YAML:\n\`\`\`yaml\n${yaml}\`\`\`\n\n` +
      `failed validation:\n${findingLines}\n\n` +
      `Fix exactly these findings and re-emit the full response ` +
      `(yaml + mermaid + summary). Remember: only catalog blocks, ` +
      `sovereignty annotation on every step.`;
  }

  // Retries exhausted — ask for the closest-match message (rule 2), so the
  // operator gets a clean pivot line instead of broken YAML. A throwing LLM
  // here must not mask the validation findings we already hold.
  attempts++;
  let fallback: LLMResponse;
  try {
    fallback = await llm(
      `You could not produce a valid flow for the scenario after ${maxRetries + 1} attempts. ` +
        `Last validator findings:\n${lastFindings.map((f) => `- ${f.message}`).join("\n")}\n\n` +
        `Reply with ONLY the closest-match message per rule 2 of your instructions ` +
        `(no YAML).`,
      { system, tier: "smart" },
    );
  } catch (err) {
    console.error(`[compose] closest-match fallback call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
  }
  const message = (fallback.text ?? "").trim();
  if (message.length > 0 && !extractFence(message, "yaml")) {
    return { ok: false, kind: "no-match", message, attempts };
  }
  return { ok: false, kind: "invalid", findings: lastFindings, lastYaml, attempts };
}
