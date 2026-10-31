import { parse } from "yaml";
import { validateSteps } from "../../lib/step-runner";
import type { PipelineStep } from "../../types/pipeline";
export interface CatalogEntry {
    name: string;
    description: string;
    input: Record<string, {
        type: string;
        required?: boolean;
    }>;
    output: Record<string, {
        type: string;
    }>;
    requires?: string[];
    tags?: string[];
}
export type SovereigntyClass = "D" | "A" | "H";
export interface StepAnnotation {
    index: number;
    label: string;
    sovereignty?: SovereigntyClass;
    residency?: string;
}
export type FindingRule = "parse-error" | "unknown-block" | "missing-input" | "missing-annotation";
export interface Finding {
    rule: FindingRule;
    step: number;
    message: string;
}
export interface ValidationResult {
    valid: boolean;
    findings: Finding[];
    annotations: StepAnnotation[];
}
export interface ValidatePipelineOptions {
    initialFields?: string[];
}
const SOVEREIGNTY_RE = /#\s*sovereignty:\s*([DAH])\s*(?:,\s*residency:\s*([A-Za-z][\w-]*))?/;
interface RawStep {
    line: number;
    sovereignty?: SovereigntyClass;
    residency?: string;
}
function scanStepAnnotations(rawYaml: string): RawStep[] {
    const lines = rawYaml.split("\n");
    const actionsIdx = lines.findIndex((l) => /^actions:\s*(#.*)?$/.test(l));
    if (actionsIdx === -1)
        return [];
    let itemIndent: number | null = null;
    const steps: RawStep[] = [];
    for (let i = actionsIdx + 1; i < lines.length; i++) {
        const line = (lines[i] ?? "");
        if (/^\S/.test(line) && !/^\s*$/.test(line))
            break;
        const m = line.match(/^(\s*)-\s/);
        if (!m)
            continue;
        const indent = (m[1] ?? "").length;
        if (itemIndent === null)
            itemIndent = indent;
        if (indent !== itemIndent)
            continue;
        const step: RawStep = { line: i };
        const trailing = line.match(SOVEREIGNTY_RE);
        const aboveRaw = i > 0 ? (lines[i - 1] ?? "") : "";
        const aboveComment = aboveRaw.match(/^(\s*)#/);
        const aboveMatch = aboveComment && (aboveComment[1] ?? "").length === itemIndent
            ? aboveRaw.match(SOVEREIGNTY_RE)
            : null;
        const hit = trailing ?? aboveMatch;
        if (hit) {
            step.sovereignty = hit[1] as SovereigntyClass;
            if (hit[2])
                step.residency = hit[2];
        }
        steps.push(step);
    }
    return steps;
}
function childActions(step: Exclude<PipelineStep, string>): PipelineStep[][] {
    if ("map" in step)
        return [step.map.actions];
    if ("filter" in step)
        return [step.filter.actions];
    if ("reduce" in step)
        return [step.reduce.actions];
    if ("retry" in step)
        return [step.retry.actions];
    if ("parallel" in step)
        return Object.values(step.parallel.branches).map((b) => b.actions);
    return [];
}
function collectActionNames(step: PipelineStep, stepIndex: number, into: Array<{
    name: string;
    stepIndex: number;
}>): void {
    if (typeof step === "string") {
        into.push({ name: step, stepIndex });
        return;
    }
    if ("research" in step) {
        for (const name of step.research.tools)
            into.push({ name, stepIndex });
    }
    for (const actions of childActions(step)) {
        for (const s of actions)
            collectActionNames(s, stepIndex, into);
    }
}
function stepLabel(step: PipelineStep): string {
    if (typeof step === "string")
        return step;
    return Object.keys(step)[0] ?? "unknown";
}
function stepOutputs(step: PipelineStep, byName: Map<string, CatalogEntry>): string[] {
    if (typeof step === "string") {
        const entry = byName.get(step);
        return entry ? Object.keys(entry.output) : [];
    }
    if ("map" in step)
        return [step.map.collect];
    if ("filter" in step)
        return [step.filter.collect];
    if ("reduce" in step)
        return [step.reduce.collect];
    if ("gate" in step)
        return [step.gate.collect ?? `gate_${step.gate.name}`];
    if ("agent" in step) return [step.agent.collect ?? `agent_${step.agent.name}`];
    if ("tribunal" in step) return [step.tribunal.collect ?? `tribunal_${step.tribunal.name}`];
    if ("governed" in step) return [step.governed.collect ?? `governed_${step.governed.name}`];
    if ("research" in step) return [step.research.collect ?? `research_${step.research.name}`];
    if ("parallel" in step) return Object.keys(step.parallel.branches);
    return [];
}
function validateStepInputs(step: PipelineStep, available: Set<string>, byName: Map<string, CatalogEntry>, findings: Finding[], index: number): void {
    if (typeof step === "string") {
        const entry = byName.get(step);
        for (const [field, spec] of Object.entries(entry?.input ?? {})) {
            if (spec.required && !available.has(field)) {
                findings.push({
                    rule: "missing-input", step: index,
                    message: `\`${step}\` requires input \`${field}\` — not provided by initial input or any prior step`,
                });
            }
        }
    } else if ("retry" in step) {
        for (const child of step.retry.actions) validateStepInputs(child, available, byName, findings, index);
    } else if ("parallel" in step) {
        for (const branch of Object.values(step.parallel.branches)) {
            const scoped = new Set(available);
            for (const child of branch.actions) validateStepInputs(child, scoped, byName, findings, index);
        }
    } else if ("map" in step || "filter" in step || "reduce" in step) {
        const scoped = new Set(available);
        const spec = "map" in step ? step.map : "filter" in step ? step.filter : step.reduce;
        if ("as" in spec) scoped.add(spec.as);
        else {
            scoped.add(spec.item_as);
            scoped.add(spec.acc_as);
        }
        for (const child of spec.actions) validateStepInputs(child, scoped, byName, findings, index);
    }
    for (const field of stepOutputs(step, byName)) available.add(field);
}
export function validatePipeline(rawYaml: string, catalog: CatalogEntry[], options: ValidatePipelineOptions = {}): ValidationResult {
    const findings: Finding[] = [];
    const annotations: StepAnnotation[] = [];
    let parsed: unknown;
    try {
        parsed = parse(rawYaml);
    }
    catch (err) {
        findings.push({
            rule: "parse-error",
            step: -1,
            message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { valid: false, findings, annotations };
    }
    const doc = parsed as {
        name?: unknown;
        actions?: unknown;
    } | null;
    if (!doc || !Array.isArray(doc.actions) || doc.actions.length === 0) {
        findings.push({ rule: "parse-error", step: -1, message: "pipeline must declare a non-empty `actions:` list" });
        return { valid: false, findings, annotations };
    }
    let steps: PipelineStep[];
    try {
        steps = validateSteps(doc.actions);
    }
    catch (err) {
        findings.push({
            rule: "parse-error",
            step: -1,
            message: `invalid step shape: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { valid: false, findings, annotations };
    }
    const byName = new Map(catalog.map((e) => [e.name, e]));
    const names: Array<{
        name: string;
        stepIndex: number;
    }> = [];
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
    const available = new Set(options.initialFields ?? []);
    steps.forEach((step, idx) => validateStepInputs(step, available, byName, findings, idx));
    const rawSteps = scanStepAnnotations(rawYaml);
    steps.forEach((step, idx) => {
        const raw = rawSteps[idx];
        const annotation: StepAnnotation = { index: idx, label: stepLabel(step) };
        if (raw?.sovereignty) {
            annotation.sovereignty = raw.sovereignty;
            if (raw.residency)
                annotation.residency = raw.residency;
        }
        else {
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
