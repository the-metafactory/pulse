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

type FlowEvent = { reads: PipelineStep; index: number } | { writes: PipelineStep; index: number };

/** A step reads before its children run and writes only once they have, so a step around a reader does not hide it. */
function flowEvents(step: PipelineStep, index: number): FlowEvent[] {
  const children = typeof step === "string" ? [] : childActions(step).flat().flatMap((child) => flowEvents(child, index));
  return [{ reads: step, index }, ...children, { writes: step, index }];
}

function findingFor(judgment: Exclude<PipelineStep, string>, index: number, field: string, { label, needed }: Consumer): Finding | null {
  const finding = (message: string): Finding => ({ rule: "untyped-input", step: index, message });
  if ("research" in judgment) {
    return needed === "string" ? null : finding(`research step \`${judgment.research.name}\` writes free text, but ${label} needs ${needed}; put an agent step with \`returns: ${needed}\` after it to collect \`${field}\``);
  }
  if (!("agent" in judgment)) return null;
  const { name, returns } = judgment.agent;
  return returns && suits(returns, needed) ? null : finding(`agent step \`${name}\` feeds ${label}; declare \`returns: ${needed}\` on it and collect only that one value`);
}

/** Where a judgment's free text reaches a declared input without the step saying what it yields; the model is sent back to fix these. */
export function typedInputFindings(yaml: string, catalog: CatalogEntry[]): Finding[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const events = readFlow(yaml).steps.flatMap((step, index) => flowEvents(step, index));
  const findings: Finding[] = [];
  events.forEach((event, position) => {
    if (!("writes" in event) || typeof event.writes === "string" || !("agent" in event.writes || "research" in event.writes)) return;
    const [field] = stepOutputs(event.writes, byName);
    if (field === undefined) return;
    for (const later of events.slice(position + 1)) {
      if ("writes" in later) {
        if (stepOutputs(later.writes, byName).includes(field)) break;
        continue;
      }
      for (const consumer of readers(later.reads, field, byName)) {
        const finding = findingFor(event.writes, event.index, field, consumer);
        if (finding) findings.push(finding);
      }
    }
  });
  return findings;
}
