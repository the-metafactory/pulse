import type { PipelineStep } from "../../types/pipeline";
import { flatten, readFlow } from "./delivery";
import { childActions, stepOutputs, type CatalogEntry, type Finding } from "./validate-pipeline";

const ACTS_ON_THE_WORLD = ["send", "deliver", "post", "publish", "notify", "write"];
const TYPED_CONFIG = new Set(["url", "integer", "number", "boolean"]);
const PLACEHOLDER = /\{([\w.]+)\}/g;
const TRUNCATING_INPUT = "limit";

type Catalog = Map<string, CatalogEntry>;
type Composite = Exclude<PipelineStep, string>;

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : [];
}

function overField(step: Composite): string[] {
  if ("map" in step) return [step.map.over];
  if ("filter" in step) return [step.filter.over];
  return "reduce" in step ? [step.reduce.over] : [];
}

/** Every field a step may read: an action's declared inputs, and any field a primitive names or renders into a prompt. */
function fieldsRead(step: PipelineStep, byName: Catalog): Set<string> {
  if (typeof step === "string") return new Set(Object.keys(byName.get(step)?.input ?? {}));
  const read = new Set<string>(overField(step));
  for (const text of stringsIn(step)) {
    for (const [, path] of text.matchAll(PLACEHOLDER)) read.add(path?.split(".")[0] ?? "");
  }
  for (const child of childActions(step).flat()) for (const field of fieldsRead(child, byName)) read.add(field);
  return read;
}

const actsOnTheWorld = (entry: CatalogEntry | undefined): boolean => ACTS_ON_THE_WORLD.some((tag) => entry?.tags?.includes(tag));

/** A retry hands its output on, so its children stand where it stands; other primitives keep their children's fields to themselves. */
function inSequence(step: PipelineStep): PipelineStep[] {
  return typeof step !== "string" && "retry" in step ? step.retry.actions.flatMap(inSequence) : [step];
}

function stepName(step: PipelineStep): string {
  if (typeof step === "string") return step;
  if ("agent" in step) return step.agent.name;
  if ("research" in step) return step.research.name;
  return Object.keys(step)[0] ?? "step";
}

function mustBeRead(step: PipelineStep, byName: Catalog): boolean {
  if (typeof step === "string") return !actsOnTheWorld(byName.get(step));
  return "agent" in step || "research" in step || "map" in step || "filter" in step || "reduce" in step || "parallel" in step;
}

function unreadOutputs(steps: { step: PipelineStep; index: number }[], byName: Catalog): Finding[] {
  return steps.slice(0, -1).flatMap(({ step, index }, position) => {
    const outputs = stepOutputs(step, byName);
    if (outputs.length === 0 || !mustBeRead(step, byName)) return [];
    const later = steps.slice(position + 1).map((next) => fieldsRead(next.step, byName));
    if (outputs.some((field) => later.some((read) => read.has(field)))) return [];
    const written = outputs.map((field) => `\`${field}\``).join(", ");
    return [{ rule: "unread-data" as const, step: index, message: `\`${stepName(step)}\` writes ${written}, but no later step reads it, so it is lost. An agent step sees only its rendered prompt: put the field in the prompt of the step that works from it, such as {${outputs[0]}}, or remove this step` }];
  });
}

/** Binds the item a collection step hands its children, when the collection itself came from the data. */
function itemFields(step: Composite, data: Set<string>): string[] {
  if (!overField(step).some((field) => data.has(field))) return [];
  if ("map" in step) return [step.map.as];
  if ("filter" in step) return [step.filter.as];
  return "reduce" in step ? [step.reduce.item_as, step.reduce.acc_as] : [];
}

/** Walks in order, tracking which fields descend from what an action or research step brought in, and names each judgment that reads none of them. */
function judgmentsWithoutData(steps: PipelineStep[], index: number | null, data: Set<string>, byName: Catalog, findings: Finding[]): void {
  steps.forEach((step, position) => {
    const at = index ?? position;
    if (typeof step === "string") {
      if (!actsOnTheWorld(byName.get(step))) for (const field of stepOutputs(step, byName)) data.add(field);
      return;
    }
    if ("research" in step) {
      for (const field of stepOutputs(step, byName)) data.add(field);
      return;
    }
    if ("agent" in step) {
      const reads = [...fieldsRead(step, byName)].some((field) => data.has(field));
      if (reads) for (const field of stepOutputs(step, byName)) data.add(field);
      else if (data.size > 0 && !TYPED_CONFIG.has(step.agent.returns ?? "")) {
        const fields = [...data].map((field) => `{${field}}`).join(", ");
        findings.push({ rule: "unread-data", step: at, message: `agent step \`${step.agent.name}\` runs after the flow has data, but its prompt reads none of it, and it sees only its prompt, so it would invent its answer. Put what it works from in its prompt: ${fields}` });
      }
      return;
    }
    if ("retry" in step) {
      judgmentsWithoutData(step.retry.actions, at, data, byName, findings);
      return;
    }
    childActions(step).forEach((children) => {
      const inner = new Set([...data, ...itemFields(step, data)]);
      const before = inner.size;
      judgmentsWithoutData(children, at, inner, byName, findings);
      if (inner.size > before || itemFields(step, data).length > 0) for (const field of stepOutputs(step, byName)) data.add(field);
    });
  });
}

function unsetLimits(steps: PipelineStep[], input: Record<string, unknown>, byName: Catalog): Finding[] {
  const available = new Set(Object.keys(input));
  return steps.flatMap((step, index) => flatten(step).flatMap((inner) => {
    const unset = typeof inner === "string" && byName.get(inner)?.input[TRUNCATING_INPUT] && !available.has(TRUNCATING_INPUT);
    for (const field of stepOutputs(inner, byName)) available.add(field);
    return unset ? [{ rule: "unset-limit" as const, step: index, message: `\`${String(inner)}.${TRUNCATING_INPUT}\` cuts off what it returns, and left unset a small default decides how much the routine sees. Set it for what the request needs, under a top-level input: map, such as limit: 150 for a day of a busy news feed` }] : [];
  }));
}

/** Where a composed flow would lose its data or invent an answer because a step never reads what it needs; the model is sent back to fix these. */
export function readsDataFindings(yaml: string, catalog: CatalogEntry[]): Finding[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const { steps, input } = readFlow(yaml);
  const sequence = steps.flatMap((step, index) => inSequence(step).map((inner) => ({ step: inner, index })));
  const findings = [...unreadOutputs(sequence, byName), ...unsetLimits(steps, input, byName)];
  judgmentsWithoutData(steps, null, new Set(), byName, findings);
  return findings;
}
