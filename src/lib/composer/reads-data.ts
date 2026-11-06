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

/** The manifest's declared effect decides; tags speak only for a manifest that declares none. */
const actsOnTheWorld = (entry: CatalogEntry | undefined): boolean => entry?.effect ? entry.effect === "write" : ACTS_ON_THE_WORLD.some((tag) => entry?.tags?.includes(tag));

/** What an action brought in: a collection when it has one, since a scalar beside it such as a feed's title is metadata. */
function dataFields(step: PipelineStep, byName: Catalog): string[] {
  if (typeof step !== "string") return stepOutputs(step, byName);
  const output = Object.entries(byName.get(step)?.output ?? {});
  const collections = output.filter(([, spec]) => spec.type === "array" || spec.type === "object");
  return (collections.length > 0 ? collections : output).map(([field]) => field);
}

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
  if (flatten(step).some((inner) => typeof inner === "string" && actsOnTheWorld(byName.get(inner)))) return false;
  return typeof step === "string" || "agent" in step || "research" in step || "map" in step || "filter" in step || "reduce" in step || "parallel" in step;
}

function unreadOutputs(steps: { step: PipelineStep; index: number }[], byName: Catalog): Finding[] {
  return steps.slice(0, -1).flatMap(({ step, index }, position) => {
    const outputs = dataFields(step, byName);
    if (outputs.length === 0 || !mustBeRead(step, byName)) return [];
    const later = steps.slice(position + 1).map((next) => fieldsRead(next.step, byName));
    if (outputs.some((field) => later.some((read) => read.has(field)))) return [];
    const written = outputs.map((field) => `\`${field}\``).join(", ");
    return [{ rule: "unread-data" as const, step: index, message: `\`${stepName(step)}\` writes ${written}, but no later step reads it, so it is lost. An agent step sees only its rendered prompt: put the field in the prompt of the step that works from it, such as {${outputs[0]}}, or remove this step` }];
  });
}

/** The item a collection step hands its children, when the collection itself came from the data. */
function itemFields(step: Composite, data: Set<string>): string[] {
  if (!overField(step).some((field) => data.has(field))) return [];
  if ("map" in step) return [step.map.as];
  if ("filter" in step) return [step.filter.as];
  return "reduce" in step ? [step.reduce.item_as, step.reduce.acc_as] : [];
}

class DataWalk {
  readonly findings: Finding[] = [];
  constructor(private readonly byName: Catalog) {}

  private addOutputs(step: PipelineStep, data: Set<string>): void {
    for (const field of dataFields(step, this.byName)) data.add(field);
  }

  private agent(step: Extract<Composite, { agent: unknown }>, at: number, data: Set<string>): void {
    if ([...fieldsRead(step, this.byName)].some((field) => data.has(field))) {
      this.addOutputs(step, data);
      return;
    }
    if (data.size === 0 || TYPED_CONFIG.has(step.agent.returns ?? "")) return;
    const fields = [...data].map((field) => `{${field}}`).join(", ");
    this.findings.push({ rule: "unread-data", step: at, message: `agent step \`${step.agent.name}\` runs after the flow has data, but its prompt reads none of it, and it sees only its prompt, so it would invent its answer. Put what it works from in its prompt: ${fields}` });
  }

  private children(step: Composite, at: number, data: Set<string>): void {
    const items = itemFields(step, data);
    const known = new Set([...data, ...items]);
    let broughtData = items.length > 0;
    for (const children of childActions(step)) {
      const inner = new Set(known);
      this.walk(children, at, inner);
      broughtData ||= inner.size > known.size;
    }
    if (broughtData) this.addOutputs(step, data);
  }

  /** Walks in order, tracking which fields descend from what an action or research step brought in. */
  walk(steps: PipelineStep[], at: number | null, data: Set<string>): void {
    steps.forEach((step, position) => {
      const index = at ?? position;
      if (typeof step === "string" || "research" in step) this.addOutputs(step, data);
      else if ("agent" in step) this.agent(step, index, data);
      else if ("retry" in step) this.walk(step.retry.actions, index, data);
      else this.children(step, index, data);
    });
  }
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
  const walk = new DataWalk(byName);
  walk.walk(steps, null, new Set());
  return [...unreadOutputs(sequence, byName), ...unsetLimits(steps, input, byName), ...walk.findings];
}
