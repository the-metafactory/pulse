import { z } from "zod";
import { parseDocument } from "yaml";
import { validateSteps } from "./step-runner";
import { inspectPrimitiveStep } from "./primitive-runner";
import { RETRY_EDITABLE_FIELDS } from "./retry-parameters";

const pathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1).max(40);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export const RoutinePatchSchema = z.object({ path: pathSchema, value: scalar }).strict();
export const RoutineContractInput = z.object({ yaml: z.string().min(1).max(1048576), patches: z.array(RoutinePatchSchema).max(100).default([]) }).strict();
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>;

const field = z.object({
  name: z.string(), type: z.enum(["string", "number", "boolean"]),
  minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(scalar).optional(),
});
export const RoutineFieldSchema = field;
export const RoutineStepSchema = z.object({
  path: pathSchema, action: z.string(), purpose: z.string(),
  parameters: z.array(z.object({ name: z.string(), kind: z.enum(["literal", "binding", "redacted"]), value: scalar.nullable() })),
  editable: z.array(field), reason: z.string(),
});
export const RoutineFlowViewSchema = z.object({ name: z.string(), steps: z.array(RoutineStepSchema) });
export type RoutineFlowView = z.infer<typeof RoutineFlowViewSchema>;

const retryFields = z.array(field).parse(RETRY_EDITABLE_FIELDS);
const record = z.record(z.unknown());
const docSchema = z.object({ name: z.string().min(1), actions: z.array(z.unknown()).min(1) }).passthrough();
const safeScalar = (value: unknown): string | number | boolean | null => scalar.safeParse(value).success ? scalar.parse(value) : null;
const pointer = (path: (string | number)[]): string => JSON.stringify(path);
const referenceFields = new Map<string, ReadonlySet<string>>([
  ["map", new Set(["over", "as", "collect"])],
  ["filter", new Set(["over", "as", "keep_field", "collect"])],
  ["reduce", new Set(["over", "item_as", "acc_as", "collect"])],
  ["agent", new Set(["collect"])],
]);

function inspect(value: unknown): RoutineFlowView {
  const doc = docSchema.parse(value);
  validateSteps(doc.actions);
  const steps: RoutineFlowView["steps"] = [];
  const walk = (actions: unknown[], prefix: (string | number)[], connection: string): void => {
    actions.forEach((raw, index) => {
      const path = [...prefix, index];
      if (typeof raw === "string") {
        steps.push({ path, action: raw, purpose: connection, parameters: [], editable: [], reason: "This action reads the shared flow input and has no editable step parameters." });
        return;
      }
      const object = record.parse(raw);
      const entry = inspectPrimitiveStep(object, pointer(path));
      const action = entry.key;
      const params = entry.spec;
      const editable = action === "retry" ? retryFields : [];
      const parameters = Object.entries(params).filter(([key]) => key !== "actions" && key !== "branches").map(([name, input]) => {
        const binding = typeof input === "string" && (Boolean(/^\{[A-Za-z_][\w.]*\}$/.exec(input)) || (Boolean(referenceFields.get(action)?.has(name)) && Boolean(/^[A-Za-z_][\w.]*$/.exec(input))));
        const declared = editable.some((f) => f.name === name);
        return { name, kind: binding ? "binding" as const : declared ? "literal" as const : "redacted" as const, value: binding || declared ? safeScalar(input) : null };
      });
      steps.push({ path, action, purpose: connection, parameters, editable, reason: editable.length ? "Only these retry parameters can be edited." : "This step does not support parameter editing. Private or unclassified values are hidden." });
      if (Array.isArray(params.actions)) walk(params.actions, [...path, action, "actions"], `${connection} → ${action} body`);
      if (params.branches) for (const [branch, data] of Object.entries(record.parse(params.branches))) {
        const branchData = record.parse(data);
        if (Array.isArray(branchData.actions)) walk(branchData.actions, [...path, action, "branches", branch, "actions"], `${connection} → branch ${branch}`);
      }
    });
  };
  walk(doc.actions, ["actions"], "Sequence");
  return { name: doc.name, steps };
}

export function routineContract(input: z.input<typeof RoutineContractInput>) {
  const request = RoutineContractInput.parse(input);
  const document = parseDocument(request.yaml, { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid flow YAML");
  const before = inspect(document.toJS());
  const seen = new Set<string>();
  for (const patch of request.patches) {
    const key = pointer(patch.path);
    if (seen.has(key)) throw new Error("A parameter may be edited only once per request");
    seen.add(key);
    const step = before.steps.find((entry) => pointer([...entry.path, entry.action]) === pointer(patch.path.slice(0, -1)));
    const declared = step?.editable.find((entry) => entry.name === patch.path.at(-1));
    if (!declared) throw new Error(`${key}: parameter is not declared editable`);
    if (typeof patch.value !== declared.type) throw new Error(`${key}: expected ${declared.type}`);
    if (typeof patch.value === "number" && (!Number.isSafeInteger(patch.value) || (declared.minimum !== undefined && patch.value < declared.minimum) || (declared.maximum !== undefined && patch.value > declared.maximum))) throw new Error(`${key}: value outside allowed integer range`);
    if (declared.enum && !declared.enum.includes(patch.value)) throw new Error(`${key}: value is not an allowed choice`);
    document.setIn(patch.path, patch.value);
  }
  const view = inspect(document.toJS());
  return { view, ...(request.patches.length ? { yaml: document.toString() } : {}) };
}
