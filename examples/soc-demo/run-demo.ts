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
import type { AgentProvider, AgentTaskSpec, AgentTaskResult } from "../../src/types/agent";

// ---------------------------------------------------------------------------
// Local LLM agent provider — executes `agent:` steps without the fleet
// ---------------------------------------------------------------------------

/**
 * Runs an `agent:` step's (already-rendered) prompt against the SAME injected
 * LLM the composer uses, returning the model's text as the step output — the
 * demo stand-in for fleet dispatch (`MyelinAgentProvider`), so judgment-step
 * flows can run with just an `ANTHROPIC_API_KEY`, no NATS.
 *
 * SOVEREIGNTY (demo-only routing, fail-closed): this provider has only ONE
 * backend — the injected frontier composer LLM. It is NOT the fleet, so it
 * cannot route a task to a local model. Rather than silently exfiltrate, it
 * REFUSES (fails the task) any spec whose sovereignty forbids the frontier —
 * `model_class: "local-only"` or `frontier_ok: false`. Tasks with no such
 * constraint run on the frontier LLM. Real routing-by-sovereignty (sending
 * local-only work to a local model) is `MyelinAgentProvider` + the fleet;
 * this provider is an offline/single-key convenience, not that boundary.
 *
 * A failed LLM call (or a refusal) surfaces as a failed task, never a throw
 * that strands the pipeline.
 */
export function makeLocalLlmAgentProvider(llm: ComposerLLM): AgentProvider {
  return {
    async dispatch(spec: AgentTaskSpec): Promise<AgentTaskResult> {
      const startedAt = Date.now();
      const taskId = crypto.randomUUID();
      // Fail closed: this provider only has a frontier backend. If the task
      // forbids the frontier, refuse rather than leak the payload to it.
      const sov = spec.sovereignty;
      if (sov?.model_class === "local-only" || sov?.frontier_ok === false) {
        return {
          task_id: taskId,
          status: "failed",
          output: null,
          error:
            `refused: task '${spec.capability}' requires a local model ` +
            `(model_class=${sov.model_class ?? "?"}, frontier_ok=${sov.frontier_ok ?? "?"}); ` +
            `the demo local provider only has frontier access — route via the fleet (MyelinAgentProvider)`,
          duration_ms: Date.now() - startedAt,
        };
      }
      try {
        const res = await llm(spec.prompt, {
          system:
            "You are a SOC analyst agent executing one step of a security pipeline. " +
            "Respond concisely with the requested assessment as plain text — no preamble.",
          tier: "smart",
        });
        // The provider returns the model's text under `AgentTaskResult.output`.
        // The step-runner stores that VALUE (result.output) under the agent's
        // `collect` field (primitive-runner.ts, P-600) — so a downstream block
        // reading a scalar (`collect: email` → A_FETCH_HIBP) gets the string
        // directly, not an envelope.
        return {
          task_id: taskId,
          status: "completed",
          output: (res.text ?? "").trim(),
          duration_ms: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          task_id: taskId,
          status: "failed",
          output: null,
          error: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - startedAt,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama agent provider — executes `agent:` steps on a LOCAL model
// ---------------------------------------------------------------------------

export interface OllamaProviderOpts {
  /** Ollama model tag, e.g. "llama3.2:latest". Default: $PULSE_LOCAL_MODEL or "llama3.2:latest". */
  model?: string;
  /** Ollama base URL. Default: $OLLAMA_URL or "http://localhost:11434". */
  url?: string;
  /** Per-call deadline. Default 120_000ms — local models are slower than frontier. */
  timeoutMs?: number;
}

/**
 * Runs an `agent:` step's prompt against a LOCAL Ollama model — the data never
 * leaves the host. This is the real backend for sovereignty-constrained steps
 * (`model_class: local-only` / `frontier_ok: false`): confidential SOC triage
 * runs here instead of a frontier model.
 *
 * Talks to Ollama's HTTP API directly (no SDK dependency). A failed/timed-out
 * call surfaces as a failed task, never a throw that strands the pipeline.
 */
export function makeOllamaAgentProvider(opts: OllamaProviderOpts = {}): AgentProvider {
  const model = opts.model ?? process.env.PULSE_LOCAL_MODEL ?? "llama3.2:latest";
  const url = (opts.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  // A big model (e.g. gemma4, 9.6 GB) on a large prompt (per-IP enrichment for
  // many IOCs) legitimately needs more than 120s. Env-overridable so an operator
  // can match the model + prompt size without a code change.
  const envTimeout = Number(process.env.PULSE_LOCAL_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000);
  return {
    async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
      const startedAt = Date.now();
      const taskId = crypto.randomUUID();
      dispatchOpts?.onDispatched?.({ task_id: taskId });
      const fail = (error: string): AgentTaskResult => ({
        task_id: taskId,
        status: "failed",
        output: null,
        error,
        duration_ms: Date.now() - startedAt,
      });
      // Already cancelled before we start → do no work, make no network call.
      if (dispatchOpts?.signal?.aborted) return fail(`ollama ${model}: task aborted before dispatch`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Cancel an in-flight call if the step-runner aborts (gate fail, parent abort).
      dispatchOpts?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      try {
        const res = await fetch(`${url}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: spec.prompt,
            system:
              "You are a SOC analyst agent executing one step of a security pipeline. " +
              "Respond concisely with the requested assessment as plain text — no preamble.",
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return fail(`ollama ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        const body = (await res.json()) as { response?: string };
        return {
          task_id: taskId,
          status: "completed",
          output: (body.response ?? "").trim(),
          model,
          duration_ms: Date.now() - startedAt,
        };
      } catch (err) {
        return fail(
          controller.signal.aborted && !dispatchOpts?.signal?.aborted
            ? `ollama ${model}: timeout after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Apertus (Infomaniak AI) agent provider — a Swiss-sovereign frontier backend
// ---------------------------------------------------------------------------

export interface ApertusProviderOpts {
  /** Infomaniak API bearer token (manager → API token). */
  apiToken: string;
  /** AI Tools product id — the `{product_id}` path segment of the AI endpoint. */
  productId: string;
  /** Model id (e.g. "apertus"). */
  model?: string;
  /** API base; default https://api.infomaniak.com. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Dispatch agent tasks to Apertus via Infomaniak's AI Tools API — an
 * OpenAI-compatible chat-completions endpoint
 * (`POST {base}/1/ai/{product_id}/openai/chat/completions`, Bearer auth).
 * Apertus is Swiss-hosted, so this is a SOVEREIGN frontier alternative to a US
 * model: data stays in Switzerland. It is still CLOUD, so it must NOT serve a
 * `model_class: "local-only"` task (data must not leave the box) — the
 * sovereign router keeps those on Ollama; Apertus only takes the frontier path.
 */
export function makeApertusAgentProvider(opts: ApertusProviderOpts): AgentProvider {
  const model = opts.model ?? process.env.APERTUS_MODEL ?? "apertus";
  const base = (opts.baseUrl ?? "https://api.infomaniak.com").replace(/\/$/, "");
  const endpoint = `${base}/1/ai/${opts.productId}/openai/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
      const startedAt = Date.now();
      const taskId = crypto.randomUUID();
      dispatchOpts?.onDispatched?.({ task_id: taskId });
      const fail = (error: string): AgentTaskResult => ({
        task_id: taskId,
        status: "failed",
        output: null,
        error,
        duration_ms: Date.now() - startedAt,
      });
      if (dispatchOpts?.signal?.aborted) return fail(`apertus ${model}: task aborted before dispatch`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      dispatchOpts?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a SOC analyst agent executing one step of a security pipeline. " +
                  "Respond concisely with the requested assessment as plain text — no preamble.",
              },
              { role: "user", content: spec.prompt },
            ],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return fail(`apertus ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        // Infomaniak's AI endpoint is OpenAI-compatible (choices[].message.content).
        // Tolerate a result/data envelope just in case (the generic API shape).
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          data?: { choices?: { message?: { content?: string } }[] };
        };
        const choices = body.choices ?? body.data?.choices;
        const output = choices?.[0]?.message?.content;
        if (typeof output !== "string") {
          return fail(`apertus ${model}: no choices[0].message.content in response`);
        }
        return {
          task_id: taskId,
          status: "completed",
          output: output.trim(),
          model,
          duration_ms: Date.now() - startedAt,
        };
      } catch (err) {
        return fail(
          controller.signal.aborted && !dispatchOpts?.signal?.aborted
            ? `apertus ${model}: timeout after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Build the Apertus provider from env, or null when not configured. */
export function makeApertusAgentProviderFromEnv(): AgentProvider | null {
  const apiToken = process.env.APERTUS_API_TOKEN ?? process.env.INFOMANIAK_API_TOKEN;
  const productId = process.env.APERTUS_PRODUCT_ID ?? process.env.INFOMANIAK_AI_PRODUCT_ID;
  if (!apiToken || !productId) return null;
  return makeApertusAgentProvider({
    apiToken,
    productId,
    ...(process.env.APERTUS_MODEL !== undefined && { model: process.env.APERTUS_MODEL }),
    ...(process.env.APERTUS_URL !== undefined && { baseUrl: process.env.APERTUS_URL }),
  });
}

// ---------------------------------------------------------------------------
// Sovereign agent provider — route each task by its declared sovereignty
// ---------------------------------------------------------------------------

/**
 * The honest version of fleet routing-by-sovereignty, in one box: a task whose
 * sovereignty forbids the frontier (`model_class: "local-only"` or
 * `frontier_ok: false`) goes to the `local` backend (Ollama); everything else
 * goes to `frontier` (the composer LLM). This is what lets a flow the composer
 * marked `local-only` actually EXECUTE — confidential steps on a local model,
 * the rest on the frontier — instead of being refused.
 *
 * `frontier` keeps its own fail-closed guard (makeLocalLlmAgentProvider), so if
 * a local-only task ever reached it by mistake it would refuse rather than
 * leak — defense in depth, not the primary boundary.
 */
export function makeSovereignAgentProvider(backends: {
  frontier: AgentProvider;
  local: AgentProvider;
}): AgentProvider {
  return {
    async dispatch(spec: AgentTaskSpec, dispatchOpts): Promise<AgentTaskResult> {
      const sov = spec.sovereignty;
      const mustStayLocal = sov?.model_class === "local-only" || sov?.frontier_ok === false;
      const backend = mustStayLocal ? backends.local : backends.frontier;
      return backend.dispatch(spec, dispatchOpts);
    },
  };
}

/**
 * Resolve the agent provider from the environment. The CLI and the rehearsal
 * harness both call this; the Yarrow bot pack is INTENDED to call it too once
 * its handler is wired (follow-up — not in this change).
 *
 *   PULSE_LOCAL_MODEL or OLLAMA_URL set → sovereign routing: `local-only`
 *     steps run on Ollama, the rest on the frontier backend, so a flow the
 *     composer marked local-only EXECUTES end-to-end.
 *   APERTUS_API_TOKEN + APERTUS_PRODUCT_ID set → the FRONTIER backend is Apertus
 *     (Infomaniak AI, Swiss-hosted) instead of the US composer LLM — a sovereign
 *     frontier. `local-only` steps still run on-box (Ollama); Apertus, being
 *     cloud, never serves them. A flow that wants Apertus for triage marks that
 *     step `frontier_ok: true` (not `local-only`).
 *   nothing set → undefined; runScenario falls back to the frontier-only
 *     provider, which fail-closes (refuses) local-only steps — the offline /
 *     single-key default.
 */
export function resolveAgentProvider(llm: ComposerLLM): AgentProvider | undefined {
  const localEnabled = Boolean(process.env.PULSE_LOCAL_MODEL || process.env.OLLAMA_URL);
  const apertus = makeApertusAgentProviderFromEnv();
  if (!localEnabled && apertus === null) return undefined;
  return makeSovereignAgentProvider({
    // Frontier = Apertus (Swiss-sovereign) when configured, else the composer LLM.
    frontier: apertus ?? makeLocalLlmAgentProvider(llm),
    // local-only stays on-box (Ollama); if Ollama isn't set, the frontier-only
    // provider fail-closes those (never routes confidential data to cloud).
    local: localEnabled ? makeOllamaAgentProvider() : makeLocalLlmAgentProvider(llm),
  });
}

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
  /**
   * Executes `agent:` steps. Default: a local LLM provider built from `llm`
   * (lets judgment-step flows run with just the API key — see
   * {@link makeLocalLlmAgentProvider} for its sovereignty limitation). Pass an
   * explicit provider (the fleet `MyelinAgentProvider`, or a test double) to
   * override; pass `null` to disable (agent steps then fail as before).
   */
  agentProvider?: AgentProvider | null;
  /** Initial payload fields available to the flow. Default: { scenario, text: scenario }. */
  initialInput?: Record<string, unknown>;
  /** Skip Mermaid PNG rendering (tests). */
  render?: boolean;
}

export type RunScenarioResult =
  | { status: "no-match"; message: string }
  | { status: "invalid"; findings: unknown[] }
  | { status: "aborted"; notes: string }
  // On BOTH a `complete` and a `failed` run the composed `yaml` + flow `name`
  // are surfaced so a host (e.g. the Yarrow bot pack) can PERSIST the flow as a
  // re-runnable playbook — see runSavedFlow for the no-compose re-run path.
  | { status: "complete" | "failed"; output?: Record<string, unknown>; error?: string; yaml?: string; name?: string };

/**
 * Sanitize a YAML-controlled flow name for safe display in a chat channel.
 * Whitelist to a flow-id charset so a hostile/odd `name:` cannot inject
 * markdown, links, or mass mentions (e.g. `@everyone`) into the operator
 * channel. Used wherever the name appears OUTSIDE a code fence.
 */
function sanitizeFlowName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : "flow";
}

/**
 * Neutralize code-fence delimiters in untrusted text posted INSIDE a ```fence.
 * A ``` in the body would close the fence early and let following text render
 * as channel markdown (mentions/links). A zero-width space keeps it visible but
 * no longer a delimiter.
 */
export function fenceSafe(s: string): string {
  return s.replace(/```/g, "`\u200b``");
}

/**
 * Neutralize mass-mentions + fence delimiters in untrusted text posted OUTSIDE
 * a fence (e.g. the bolded summary line). Breaks `@everyone`/`@here` and ``` so
 * a hostile composer summary or saved-flow summary can't ping the channel.
 */
export function channelSafe(s: string): string {
  return fenceSafe(s).replace(/@(everyone|here)/gi, "@\u200b$1");
}

/**
 * Validate → (lead) → post → operator-ack → execute → artifact. The shared tail
 * of both runScenario (composed YAML) and runSavedFlow (loaded YAML). The
 * wiring is the enforcement point: it re-validates independently and REFUSES to
 * run a flow whose validation isn't clean, and never executes without an
 * operator pass. `leadPost` (if given) is posted only AFTER validation passes —
 * callers use it for a header line whose text derives from untrusted YAML, so
 * nothing YAML-controlled reaches the channel before the validator clears it.
 */
interface ExecuteFlowArgs {
  opts: RunScenarioOptions;
  flow: { yaml: string; mermaid: string | null; summary: string };
  catalog: Awaited<ReturnType<typeof buildCatalog>>;
  initialInput: Record<string, unknown>;
  blocksDir: string;
  /** Header line posted only AFTER validation (callers pass sanitized text). */
  leadPost?: string;
  /**
   * Skip the flow-YAML re-display AND the outer "Run this flow?" operator-ack,
   * executing directly. This path does NOT verify the YAML or its provenance —
   * it treats the call itself as pre-approved, so the CALLER is the trust
   * boundary and is responsible for only setting it when both the YAML source
   * and the invocation are trusted. The flow's OWN internal `gate:` steps (e.g.
   * an analyst-approve before a reset fires) STILL prompt regardless — those are
   * the flow's designed in-run checkpoints, independent of this outer ack.
   */
  autoApprove?: boolean;
}

async function executeValidatedFlow(args: ExecuteFlowArgs): Promise<RunScenarioResult> {
  const { opts, flow, catalog, initialInput, blocksDir, leadPost, autoApprove } = args;
  // Independent re-validation FIRST — the wiring is the enforcement point. A
  // malformed/invalid saved YAML must surface as `invalid` here, never throw
  // out of a later parse (sage), so validation precedes parseYaml.
  const validation = validatePipeline(flow.yaml, catalog, { initialFields: Object.keys(initialInput) });
  if (!validation.valid) {
    await opts.poster.post(`🛑 Validator refused the flow:\n${validation.findings.map((f) => `- ${f.message}`).join("\n")}`);
    return { status: "invalid", findings: validation.findings };
  }
  // Post the caller's lead only after validation. The lead is already
  // sanitized by the caller (sanitizeFlowName) — sanitization is the primary
  // guard; posting post-validation is a secondary belt.
  if (leadPost !== undefined) await opts.poster.post(leadPost);

  // Safe to parse now (validatePipeline parsed it cleanly); guard anyway.
  let doc: { name?: string; actions: unknown[] };
  try {
    doc = parseYaml(flow.yaml) as { name?: string; actions: unknown[] };
  } catch (err) {
    await opts.poster.post(`🛑 Validator refused the flow: unparseable YAML — ${err instanceof Error ? err.message : String(err)}`);
    return { status: "invalid", findings: [{ message: "unparseable YAML" }] };
  }
  const name = doc.name ?? "F_COMPOSED";

  // Post YAML + diagram + summary + operator-ack — UNLESS autoApprove (a saved
  // flow re-run, where the `run <NAME>` command was the approval). fenceSafe()
  // neutralizes any ``` inside the (untrusted) yaml/mermaid so a crafted body
  // can't close the code fence early and inject channel markdown/mentions after
  // it (sage); channelSafe() neutralizes mass-mentions in the bolded summary.
  if (!autoApprove) {
    const png = opts.render === false ? null : await renderMermaid(flow.mermaid ?? "");
    const diagramPart = png ? undefined : flow.mermaid ? `\n\`\`\`mermaid\n${fenceSafe(flow.mermaid)}\`\`\`` : "";
    await opts.poster.post(
      `**${channelSafe(flow.summary)}**\n\`\`\`yaml\n${fenceSafe(flow.yaml)}\`\`\`${diagramPart ?? ""}`,
      png ? { bytes: png, filename: "flow.png" } : undefined,
    );

    // Operator ack — nothing runs without it (skipped when autoApprove).
    const ack = await opts.gateProvider.requestVerdict({ name: "operator-ack", prompt: "Run this flow?" });
    if (ack.verdict !== "pass") {
      await opts.poster.post(`🛑 Aborted by operator: ${ack.notes}`);
      return { status: "aborted", notes: ack.notes };
    }
  }

  // Execute with per-step thread replies (ISC-37). agentProvider default: a
  // local LLM one so judgment-step flows run; `null` disables, explicit overrides.
  const steps = validateSteps(doc.actions);
  const agentProvider =
    opts.agentProvider === undefined ? makeLocalLlmAgentProvider(opts.llm) : opts.agentProvider;
  const result = await runPipeline({ name, actions: steps }, initialInput, {
    actionDirs: [blocksDir],
    gateProvider: opts.gateProvider,
    ...(agentProvider !== null && { agentProvider }),
    onActionStepEvent: (event) => {
      const line = stepLine(event, validation.annotations);
      if (line) void opts.poster.post(line);
    },
  });

  if (result.success) {
    const advisory = (result.output as { advisory_doc?: { subject?: string; markdown?: string } } | undefined)?.advisory_doc;
    const finalMessage = advisory?.markdown
      ? `🏁 **Final artifact** — ${advisory.subject ?? "advisory"}\n\n${advisory.markdown}`
      : `🏁 **Flow complete** (${result.durationMs}ms) — output fields: ${Object.keys(result.output ?? {}).map((k) => `\`${k}\``).join(", ")}`;
    await opts.poster.post(finalMessage);
    return { status: "complete", output: result.output, yaml: flow.yaml, name };
  }
  await opts.poster.post(`❌ Flow failed: ${result.error}`);
  return { status: "failed", error: result.error, yaml: flow.yaml, name };
}

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

  // (3-7) shared validate→ack→execute→artifact tail.
  return executeValidatedFlow({
    opts,
    flow: { yaml: composed.yaml, mermaid: composed.mermaid, summary: `Composed flow — ${composed.summary}` },
    catalog,
    initialInput,
    blocksDir,
  });
}

/**
 * Compose + validate a flow WITHOUT executing it — the authoring half of
 * runScenario, used to EDIT a saved playbook. The caller (Yarrow's `update`
 * verb) seeds the scenario with the existing YAML + the requested change,
 * gets back the recomposed, catalog-valid YAML, and persists it. No
 * self-disclosure post, no ack gate, no execution — editing a definition is
 * not running it (and an edit instruction carries no IOC to run on anyway).
 */
export async function composeFlow(
  scenario: string,
  opts: { llm: ComposerLLM; blocksDir?: string; initialFields?: string[] },
): Promise<
  | { status: "complete"; yaml: string; summary: string; mermaid: string | null }
  | { status: "no-match"; message: string }
  | { status: "invalid"; findings: { message: string }[] }
> {
  const blocksDir = opts.blocksDir ?? BLOCKS_DIR;
  const catalog = await buildCatalog(blocksDir);
  const composed = await compose(scenario, catalog, opts.llm, {
    initialFields: opts.initialFields ?? ["scenario", "text"],
  });
  if (!composed.ok) {
    if (composed.kind === "no-match") return { status: "no-match", message: composed.message };
    return { status: "invalid", findings: composed.findings };
  }
  return { status: "complete", yaml: composed.yaml, summary: composed.summary, mermaid: composed.mermaid };
}

/**
 * Re-run a SAVED flow with fresh input — skips COMPOSITION (no LLM authoring
 * call, no frontier-A reasoning that picks the blocks). The authoring-vs-
 * operation split: runScenario composes a playbook once (slow, frontier,
 * human-gated); runSavedFlow operates the caller's saved playbook on a new
 * artifact — the flow STRUCTURE is fixed, not re-decided by a model.
 *
 * Runs DIRECTLY (autoApprove): no flow re-display, no outer "Run this flow?"
 * ack — the call is treated as pre-approved, so the CALLER is the trust boundary
 * (this function does not verify the YAML's provenance). It STILL re-validates
 * before executing, and any internal `gate:` steps the flow DOES define still
 * prompt; a flow with no internal gate runs unattended (skipping the outer ack
 * removes the only human checkpoint such a flow had).
 *
 * NOT "no LLM" overall: the saved flow's own `agent:` steps still execute via
 * the configured agentProvider (local-only → Ollama, etc.) — the flow doing its
 * work, not re-authoring.
 */
export async function runSavedFlow(yaml: string, opts: RunScenarioOptions): Promise<RunScenarioResult> {
  const blocksDir = opts.blocksDir ?? BLOCKS_DIR;
  const catalog = await buildCatalog(blocksDir);
  const initialInput = opts.initialInput ?? { scenario: "", text: "" };
  const rawName = ((): string => {
    try {
      return (parseYaml(yaml) as { name?: string }).name ?? "saved flow";
    } catch (_err) {
      return "saved flow";
    }
  })();
  // SANITIZE the YAML-controlled name before it ever reaches the channel, and
  // post it only AFTER validation (via leadPost) — a saved flow named
  // "@everyone" or with markdown/links can't inject into the operator channel.
  const name = sanitizeFlowName(rawName);
  return executeValidatedFlow({
    opts,
    flow: { yaml, mermaid: null, summary: `Saved flow — ${name}` },
    catalog,
    initialInput,
    blocksDir,
    leadPost: `▶️ Running saved flow **${name}** (no re-composition, no re-ack).`,
    // `run <NAME>` IS the approval — execute directly, no flow re-display, no
    // outer operator-ack. The flow's own internal gate: steps still prompt.
    autoApprove: true,
  });
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

  const agentProvider = resolveAgentProvider(llm);
  if (agentProvider) console.log(`🧠 local model enabled (${process.env.PULSE_LOCAL_MODEL ?? "llama3.2:latest"}) — local-only steps route to Ollama`);
  const result = await runScenario(scenario, {
    llm,
    poster,
    gateProvider,
    ...(agentProvider && { agentProvider }),
  });
  console.log(`\n[run-demo] ${result.status}`);
  process.exit(result.status === "complete" || result.status === "no-match" ? 0 : 1);
}
