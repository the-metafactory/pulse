/**
 * SOC demo execution wiring (P-805) — compose → validate → ack → run,
 * everything surfaced as thread posts (design/soc-demo-mm-composer.md §5/§6).
 *
 * Stub-safe: with no MATTERMOST_* env the poster prints to the console and
 * the ack gate reads stdin; with no LLM key the catalog-aware MockLLM emits
 * a canned-but-validator-passing flow so rehearsals run fully offline.
 *
 * Fail-closed: the composer already validates inside its retry loop; this
 * wiring re-validates independently and REFUSES to execute any flow whose
 * validation is not clean — A_VALIDATE_FLOW's contract says the wiring is
 * the enforcement point.
 *
 *   bun examples/soc-demo/run-demo.ts "credential leak at a member university"
 */

import { parse as parseYaml } from "yaml";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../../src/lib/pipeline";
import { validateSteps } from "../../src/lib/step-runner";
import { createLocalCapabilities } from "../../src/lib/capabilities";
import type { GateProvider, ActionStepEvent } from "../../src/types/pipeline";
import { StdinGateProvider } from "../../src/lib/gate-provider";
import { buildCatalog } from "./lib/catalog";
import { validatePipeline, type StepAnnotation } from "./lib/validate-pipeline";
import { compose, SELF_DISCLOSURE, type ComposerLLM } from "./composer/compose";
import { renderMermaid } from "./composer/mermaid";
import { ConsolePoster, MMAckGateProvider, MattermostThread, mmConfigFromEnv, type ThreadPoster } from "./lib/mm";

const here = dirname(fileURLToPath(import.meta.url));
export const BLOCKS_DIR = join(here, "blocks");

// ---------------------------------------------------------------------------
// Per-step thread reply (ISC-37): block name, sovereignty class, 1-line result
// ---------------------------------------------------------------------------

export function stepLine(event: ActionStepEvent, annotations: StepAnnotation[]): string | null {
  if (event.type === "step.started") return null; // one reply per step, on completion
  const annotation = annotations.find((a) => a.label === event.action);
  const cls = annotation?.sovereignty ? `\`${annotation.sovereignty}\`` : "`?`";
  const residency = annotation?.residency ? ` · ${annotation.residency}` : "";
  if (event.type === "step.failed") {
    return `❌ **${event.action}** ${cls}${residency} — failed after ${event.durationMs}ms: ${event.error.slice(0, 200)}`;
  }
  const fields = event.output_fields.length ? `→ ${event.output_fields.map((f) => `\`${f}\``).join(", ")}` : "→ (passthrough)";
  return `✅ **${event.action}** ${cls}${residency} — ${event.durationMs}ms ${fields}`;
}

// ---------------------------------------------------------------------------
// Offline composer LLM — canned flow for rehearsals without an API key
// ---------------------------------------------------------------------------

/**
 * Emits a deterministic, validator-passing flow over the installed palette.
 * D-only on purpose: IOC extraction + TLP tagging both run on the default
 * `{ scenario, text }` initial input with no external adapters.
 */
export function makeStubLLM(): ComposerLLM {
  return async () => ({
    text: [
      "```yaml",
      "name: F_STUB_TRIAGE",
      "actions:",
      "  - A_EXTRACT_IOCS  # sovereignty: D, residency: CH",
      "  - A_TAG_TLP  # sovereignty: D, residency: CH",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      '  A["A_EXTRACT_IOCS (D)"] --> B["A_TAG_TLP (D)"]',
      "```",
      "",
      "Scenario text in, refanged IOCs and a TLP marking out; fully deterministic and local.",
    ].join("\n"),
  });
}

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

export interface RunScenarioOptions {
  blocksDir?: string;
  llm: ComposerLLM;
  poster: ThreadPoster;
  gateProvider: GateProvider;
  /** Initial payload fields available to the flow. Default: { scenario, text: scenario }. */
  initialInput?: Record<string, unknown>;
  /** Skip Mermaid PNG rendering (tests). */
  render?: boolean;
}

export type RunScenarioResult =
  | { status: "no-match"; message: string }
  | { status: "invalid"; findings: unknown[] }
  | { status: "aborted"; notes: string }
  | { status: "complete" | "failed"; output?: Record<string, unknown>; error?: string };

export async function runScenario(scenario: string, opts: RunScenarioOptions): Promise<RunScenarioResult> {
  const blocksDir = opts.blocksDir ?? BLOCKS_DIR;
  const catalog = await buildCatalog(blocksDir);
  const initialInput = opts.initialInput ?? { scenario, text: scenario };

  // (1) Self-disclosure BEFORE any composition (design §3.4)
  await opts.poster.post(SELF_DISCLOSURE);

  // (2) Compose with the validator-retry loop
  const composed = await compose(scenario, catalog, opts.llm, {
    initialFields: Object.keys(initialInput),
  });
  if (!composed.ok) {
    if (composed.kind === "no-match") {
      await opts.poster.post(`🤷 ${composed.message}`);
      return { status: "no-match", message: composed.message };
    }
    await opts.poster.post(
      `🛑 Could not produce a valid flow after ${composed.attempts} attempts:\n${composed.findings.map((f) => `- ${f.message}`).join("\n")}`,
    );
    return { status: "invalid", findings: composed.findings };
  }

  // (3) Independent re-validation — the wiring is the enforcement point.
  const validation = validatePipeline(composed.yaml, catalog, { initialFields: Object.keys(initialInput) });
  if (!validation.valid) {
    await opts.poster.post(`🛑 Validator refused the flow:\n${validation.findings.map((f) => `- ${f.message}`).join("\n")}`);
    return { status: "invalid", findings: validation.findings };
  }

  // (4) Post YAML + diagram + summary. Render failure → fenced source (§8.5).
  const png = opts.render === false ? null : await renderMermaid(composed.mermaid ?? "");
  const diagramPart = png
    ? undefined
    : composed.mermaid
      ? `\n\`\`\`mermaid\n${composed.mermaid}\`\`\``
      : "";
  await opts.poster.post(
    `**Composed flow** — ${composed.summary}\n\`\`\`yaml\n${composed.yaml}\`\`\`${diagramPart ?? ""}`,
    png ? { bytes: png, filename: "flow.png" } : undefined,
  );

  // (5) Operator ack — nothing runs without it
  const ack = await opts.gateProvider.requestVerdict({
    name: "operator-ack",
    prompt: "Run this flow?",
  });
  if (ack.verdict !== "pass") {
    await opts.poster.post(`🛑 Aborted by operator: ${ack.notes}`);
    return { status: "aborted", notes: ack.notes };
  }

  // (6) Execute with per-step thread replies (ISC-37)
  const doc = parseYaml(composed.yaml) as { name?: string; actions: unknown[] };
  const steps = validateSteps(doc.actions);
  const result = await runPipeline(
    { name: doc.name ?? "F_COMPOSED", actions: steps },
    initialInput,
    {
      actionDirs: [blocksDir],
      gateProvider: opts.gateProvider,
      onActionStepEvent: (event) => {
        const line = stepLine(event, composed.annotations);
        if (line) void opts.poster.post(line);
      },
    },
  );

  // (7) Final artifact (ISC-37 tail)
  if (result.success) {
    const advisory = (result.output as { advisory_doc?: { subject?: string; markdown?: string } } | undefined)?.advisory_doc;
    const finalMessage = advisory?.markdown
      ? `🏁 **Final artifact** — ${advisory.subject ?? "advisory"}\n\n${advisory.markdown}`
      : `🏁 **Flow complete** (${result.durationMs}ms) — output fields: ${Object.keys(result.output ?? {}).map((k) => `\`${k}\``).join(", ")}`;
    await opts.poster.post(finalMessage);
    return { status: "complete", output: result.output };
  }
  await opts.poster.post(`❌ Flow failed: ${result.error}`);
  return { status: "failed", error: result.error };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const scenario = process.argv.slice(2).join(" ").trim();
  if (!scenario) {
    console.error('Usage: bun examples/soc-demo/run-demo.ts "<scenario from the audience>"');
    process.exit(1);
  }

  const mmConfig = mmConfigFromEnv();
  const thread = mmConfig ? new MattermostThread(mmConfig) : null;
  const poster: ThreadPoster = thread ?? new ConsolePoster();
  const gateProvider: GateProvider = thread ? new MMAckGateProvider(thread) : new StdinGateProvider();
  if (!mmConfig) console.log("📭 MATTERMOST_* unset — console mode (stub-safe)");

  const llm = process.env.ANTHROPIC_API_KEY
    ? (await createLocalCapabilities(["llm"])).llm!
    : (console.log("🤖 ANTHROPIC_API_KEY unset — stub composer LLM"), makeStubLLM());

  const result = await runScenario(scenario, { llm, poster, gateProvider });
  console.log(`\n[run-demo] ${result.status}`);
  process.exit(result.status === "complete" || result.status === "no-match" ? 0 : 1);
}
