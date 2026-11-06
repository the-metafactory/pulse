import type { AgentReturnType } from "../../types/agent";
import type { PipelineStep } from "../../types/pipeline";
import { AGENT_RETURN_TYPES } from "../agent-returns";
import { flatten, readFlow } from "./delivery";
import { stepOutputs, type CatalogEntry, type Finding } from "./validate-pipeline";

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

/** Where a judgment's free text reaches a declared input without the step saying what it yields; the model is sent back to fix these. */
export function typedInputFindings(yaml: string, catalog: CatalogEntry[]): Finding[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const flat = readFlow(yaml).steps.flatMap((step, index) => flatten(step).map((inner) => ({ step: inner, index })));
  const findings: Finding[] = [];
  flat.forEach(({ step, index }, position) => {
    if (typeof step === "string" || !("agent" in step || "research" in step)) return;
    const [field] = stepOutputs(step, byName);
    if (field === undefined) return;
    for (const later of flat.slice(position + 1)) {
      for (const { label, needed } of readers(later.step, field, byName)) {
        if ("research" in step) {
          if (needed !== "string") findings.push({ rule: "untyped-input", step: index, message: `research step \`${step.research.name}\` writes free text, but ${label} needs ${needed}; put an agent step with \`returns: ${needed}\` after it to collect \`${field}\`` });
        } else if (!step.agent.returns || !suits(step.agent.returns, needed)) {
          findings.push({ rule: "untyped-input", step: index, message: `agent step \`${step.agent.name}\` feeds ${label}; declare \`returns: ${needed}\` on it and collect only that one value` });
        }
      }
      if (stepOutputs(later.step, byName).includes(field)) break;
    }
  });
  return findings;
}
