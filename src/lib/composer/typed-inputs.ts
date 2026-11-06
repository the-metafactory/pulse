import type { AgentReturnType } from "../../types/agent";
import type { PipelineStep } from "../../types/pipeline";
import { AGENT_RETURN_TYPES } from "../agent-returns";
import { readFlow } from "./delivery";
import { childActions, stepOutputs, type CatalogEntry, type Finding } from "./validate-pipeline";

const NAMED_AS_URL = /(^|_)url$|Url$/;

/** What a free-text step must yield to fill this input. Manifests say only `string` for a URL, so its name says the rest. */
function neededReturn(field: string, declaredType: string): AgentReturnType | null {
  if (declaredType === "string" && NAMED_AS_URL.test(field)) return "url";
  return AGENT_RETURN_TYPES.find((type) => type === declaredType) ?? null;
}

function suits(returns: AgentReturnType, needed: AgentReturnType): boolean {
  return returns === needed || (returns === "url" && needed === "string") || (returns === "integer" && needed === "number");
}

interface Consumer {
  label: string;
  needed: AgentReturnType;
}

function readers(step: PipelineStep, field: string, byName: Map<string, CatalogEntry>): Consumer[] {
  if (typeof step === "string") {
    const declared = byName.get(step)?.input[field];
    const needed = declared ? neededReturn(field, declared.type) : null;
    return needed ? [{ label: `\`${step}.${field}\``, needed }] : [];
  }
  const collection = "map" in step ? step.map : "filter" in step ? step.filter : "reduce" in step ? step.reduce : null;
  return collection?.over === field ? [{ label: `the collection step over \`${field}\``, needed: "array" }] : [];
}

type Judgment = Extract<PipelineStep, { agent: unknown } | { research: unknown }>;
const isJudgment = (step: PipelineStep): step is Judgment => typeof step !== "string" && ("agent" in step || "research" in step);

interface FlowEvent {
  kind: "reads" | "writes";
  step: PipelineStep;
  index: number;
  scope: string;
}

/**
 * A step reads before its children run and writes once they have, so a step around a reader does not hide it.
 * What a map, filter, reduce or parallel branch writes stays inside it; retry passes it on.
 */
function flowEvents(step: PipelineStep, index: number, scope: string): FlowEvent[] {
  const events: FlowEvent[] = [{ kind: "reads", step, index, scope }];
  if (typeof step !== "string") {
    const passesOutputOn = "retry" in step;
    childActions(step).forEach((children, group) => {
      const inner = passesOutputOn ? scope : `${scope}${index}.${group}/`;
      for (const child of children) events.push(...flowEvents(child, index, inner));
    });
  }
  events.push({ kind: "writes", step, index, scope });
  return events;
}

function findingFor(judgment: Judgment, index: number, field: string, { label, needed }: Consumer): Finding | null {
  const finding = (message: string): Finding => ({ rule: "untyped-input", step: index, message });
  if ("research" in judgment) {
    return needed === "string" ? null : finding(`research step \`${judgment.research.name}\` writes free text, but ${label} needs ${needed}; put an agent step with \`returns: ${needed}\` after it to collect \`${field}\``);
  }
  const { name, returns } = judgment.agent;
  return returns && suits(returns, needed) ? null : finding(`agent step \`${name}\` feeds ${label}; declare \`returns: ${needed}\` on it and collect only that one value`);
}

/** Every declared input a judgment's value reaches: until a step in its own or an enclosing scope writes the field again. */
function consumersOf(field: string, judgmentScope: string, later: FlowEvent[], byName: Map<string, CatalogEntry>): Consumer[] {
  const consumers: Consumer[] = [];
  for (const event of later) {
    if (event.kind === "reads") {
      if (event.scope.startsWith(judgmentScope)) consumers.push(...readers(event.step, field, byName));
    } else if (judgmentScope.startsWith(event.scope) && stepOutputs(event.step, byName).includes(field)) {
      break;
    }
  }
  return consumers;
}

/** Where a judgment's free text reaches a declared input without the step saying what it yields; the model is sent back to fix these. */
export function typedInputFindings(yaml: string, catalog: CatalogEntry[]): Finding[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const events = readFlow(yaml).steps.flatMap((step, index) => flowEvents(step, index, ""));
  return events.flatMap((event, position) => {
    if (event.kind !== "writes" || !isJudgment(event.step)) return [];
    const judgment = event.step;
    const [field] = stepOutputs(judgment, byName);
    if (field === undefined) return [];
    return consumersOf(field, event.scope, events.slice(position + 1), byName).flatMap((consumer) => findingFor(judgment, event.index, field, consumer) ?? []);
  });
}
