/**
 * validatePipeline — the deterministic gate between compose and execute.
 *
 * Pure function: raw YAML + installed-block catalog in, findings out. No I/O,
 * no block execution. This is the single biggest hedge against the worst
 * stage failure (the composer inventing a block name), per
 * design/soc-demo-mm-composer.md §4.
 *
 * Naming: the on-stage demo vocabulary says "flow" (and the palette block is
 * A_VALIDATE_FLOW per the locked design), but what the composer emits and
 * this function checks is pipeline-shaped YAML (`name:` + `actions:` with
 * passthrough payload) — per CONTEXT.md, Flow is the deployment shape that
 * binds a pipeline to source/destination/schedule. The public surface here
 * uses the precise term.
 *
 * Three checks (design §4, A_VALIDATE_FLOW):
 *   (a) every block name exists in the installed catalog — including blocks
 *       nested inside map/filter/reduce/retry/parallel sub-pipelines,
 *   (b) required inputs are satisfiable from initial input or prior outputs —
 *       TOP-LEVEL plain action steps only: nested sub-pipelines bind iteration
 *       names (`as`, `item_as`, branch scopes) that static analysis here does
 *       not resolve, so their input wiring is NOT checked (finding rule
 *       "missing-input" can produce false negatives inside primitives),
 *   (c) sovereignty annotations exist on every top-level step.
 *
 * Sovereignty annotations are YAML *comments* (`# sovereignty: A, residency: EU`)
 * — they do not survive `yaml` parse, so check (c) runs as a raw-text line
 * scan. The extracted annotations are returned as a machine-readable map so
 * the execution wiring can tag per-step thread replies with D/A/H classes.
 */

import { parse } from "yaml";
import { validateSteps } from "../../../src/lib/step-runner";
import type { PipelineStep } from "../../../src/types/pipeline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  description: string;
  input: Record<string, { type: string; required?: boolean }>;
  output: Record<string, { type: string }>;
  requires?: string[];
  tags?: string[];
}

export type SovereigntyClass = "D" | "A" | "H";

export interface StepAnnotation {
  /** Zero-based position in the actions list */
  index: number;
  /** Action name for plain steps, primitive keyword otherwise (e.g. "agent", "gate") */
  label: string;
  sovereignty?: SovereigntyClass;
  residency?: string;
}

export type FindingRule =
  | "parse-error"
  | "unknown-block"
  | "missing-input"
  | "missing-annotation";

export interface Finding {
  rule: FindingRule;
  /** Zero-based step index when the finding is step-scoped, -1 for flow-level */
  step: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  findings: Finding[];
  /** Ordered per-step sovereignty annotations extracted from comments */
  annotations: StepAnnotation[];
}

export interface ValidatePipelineOptions {
  /** Field names present in the pipeline's initial input (e.g. ["scenario"]) */
  initialFields?: string[];
}

// ---------------------------------------------------------------------------
// Annotation scan (raw text — comments vanish at parse time)
// ---------------------------------------------------------------------------

const SOVEREIGNTY_RE = /#\s*sovereignty:\s*([DAH])\s*(?:,\s*residency:\s*([A-Za-z][\w-]*))?/;

interface RawStep {
  line: number;
  sovereignty?: SovereigntyClass;
  residency?: string;
}

/**
 * Find the top-level step lines under `actions:` and pair each with its
 * sovereignty comment — trailing on the step's first line, or on a pure
 * comment line immediately above it.
 */
function scanStepAnnotations(rawYaml: string): RawStep[] {
  const lines = rawYaml.split("\n");
  const actionsIdx = lines.findIndex((l) => /^actions:\s*(#.*)?$/.test(l));
  if (actionsIdx === -1) return [];

  // The indent of the first list item after `actions:` defines top level.
  let itemIndent: number | null = null;
  const steps: RawStep[] = [];

  for (let i = actionsIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line) && !/^\s*$/.test(line)) break; // next top-level key
    const m = line.match(/^(\s*)-\s/);
    if (!m) continue;
    const indent = m[1]!.length;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) continue; // nested sub-pipeline item

    const step: RawStep = { line: i };
    const trailing = line.match(SOVEREIGNTY_RE);
    const above = i > 0 ? lines[i - 1]!.trim() : "";
    const aboveMatch = above.startsWith("#") ? above.match(SOVEREIGNTY_RE) : null;
    const hit = trailing ?? aboveMatch;
    if (hit) {
      step.sovereignty = hit[1] as SovereigntyClass;
      if (hit[2]) step.residency = hit[2];
    }
    steps.push(step);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Structural walk
// ---------------------------------------------------------------------------

/**
 * Collect every plain action name reachable from a step, including nested
 * sub-pipelines, recording the owning top-level step index in one pass.
 */
function collectActionNames(
  step: PipelineStep,
  stepIndex: number,
  into: Array<{ name: string; stepIndex: number }>,
): void {
  if (typeof step === "string") {
    into.push({ name: step, stepIndex });
    return;
  }
  if ("map" in step) for (const s of step.map.actions) collectActionNames(s, stepIndex, into);
  else if ("filter" in step) for (const s of step.filter.actions) collectActionNames(s, stepIndex, into);
  else if ("reduce" in step) for (const s of step.reduce.actions) collectActionNames(s, stepIndex, into);
  else if ("retry" in step) for (const s of step.retry.actions) collectActionNames(s, stepIndex, into);
  else if ("parallel" in step) {
    for (const branch of Object.values(step.parallel.branches)) {
      for (const s of branch.actions) collectActionNames(s, stepIndex, into);
    }
  }
  // gate / agent / tribunal / governed are leaves — no catalog blocks inside
}

/** Label for annotation pairing: action name or primitive keyword. */
function stepLabel(step: PipelineStep): string {
  if (typeof step === "string") return step;
  return Object.keys(step)[0] ?? "unknown";
}

/** Fields a step contributes to the passthrough payload, per the catalog. */
function stepOutputs(step: PipelineStep, byName: Map<string, CatalogEntry>): string[] {
  if (typeof step === "string") {
    const entry = byName.get(step);
    return entry ? Object.keys(entry.output) : [];
  }
  if ("map" in step) return [step.map.collect];
  if ("filter" in step) return [step.filter.collect];
  if ("reduce" in step) return [step.reduce.collect];
  if ("gate" in step) return [step.gate.collect ?? `gate_${step.gate.name}`];
  if ("agent" in step && typeof (step.agent as { collect?: string }).collect === "string") {
    return [(step.agent as { collect: string }).collect];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validatePipeline(
  rawYaml: string,
  catalog: CatalogEntry[],
  options: ValidatePipelineOptions = {},
): ValidationResult {
  const findings: Finding[] = [];
  const annotations: StepAnnotation[] = [];

  let parsed: unknown;
  try {
    parsed = parse(rawYaml);
  } catch (err) {
    findings.push({
      rule: "parse-error",
      step: -1,
      message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, findings, annotations };
  }

  const doc = parsed as { name?: unknown; actions?: unknown } | null;
  if (!doc || !Array.isArray(doc.actions) || doc.actions.length === 0) {
    findings.push({ rule: "parse-error", step: -1, message: "pipeline must declare a non-empty `actions:` list" });
    return { valid: false, findings, annotations };
  }

  let steps: PipelineStep[];
  try {
    steps = validateSteps(doc.actions);
  } catch (err) {
    findings.push({
      rule: "parse-error",
      step: -1,
      message: `invalid step shape: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, findings, annotations };
  }

  const byName = new Map(catalog.map((e) => [e.name, e]));

  // (a) every block name exists in the catalog — including nested sub-pipelines
  const names: Array<{ name: string; stepIndex: number }> = [];
  steps.forEach((s, idx) => collectActionNames(s, idx, names));
  for (const { name, stepIndex } of names) {
    if (!byName.has(name)) {
      findings.push({
        rule: "unknown-block",
        step: stepIndex,
        message: `block \`${name}\` is not in the installed catalog`,
      });
    }
  }

  // (b) required inputs satisfiable from initial input + prior step outputs.
  // Top-level plain action steps only: nested sub-pipelines bind iteration
  // names (`as`, `item_as`) the static walk cannot resolve.
  const available = new Set(options.initialFields ?? []);
  steps.forEach((step, idx) => {
    if (typeof step === "string") {
      const entry = byName.get(step);
      if (entry) {
        for (const [field, spec] of Object.entries(entry.input)) {
          if (spec.required && !available.has(field)) {
            findings.push({
              rule: "missing-input",
              step: idx,
              message: `\`${step}\` requires input \`${field}\` — not provided by initial input or any prior step`,
            });
          }
        }
      }
    }
    for (const out of stepOutputs(step, byName)) available.add(out);
  });

  // (c) sovereignty annotation on every top-level step (raw-text scan)
  const rawSteps = scanStepAnnotations(rawYaml);
  steps.forEach((step, idx) => {
    const raw = rawSteps[idx];
    const annotation: StepAnnotation = { index: idx, label: stepLabel(step) };
    if (raw?.sovereignty) {
      annotation.sovereignty = raw.sovereignty;
      if (raw.residency) annotation.residency = raw.residency;
    } else {
      findings.push({
        rule: "missing-annotation",
        step: idx,
        message: `step ${idx} (\`${annotation.label}\`) has no \`# sovereignty: D|A|H, residency: …\` annotation`,
      });
    }
    annotations.push(annotation);
  });

  return { valid: findings.length === 0, findings, annotations };
}
