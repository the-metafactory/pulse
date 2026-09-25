/**
 * Tool schema — an action manifest as the tool definition a model sees.
 *
 * One schema, not two: `action.json` input fields carry JSON Schema keywords
 * (description, enum, default, items), and `toolSchema` turns them into the
 * `{type: "object", properties, required}` object an OpenAI-compatible
 * `tools[].function.parameters` expects. Fields pinned by a step's `bind:`
 * leave the schema entirely, so the model cannot see or set them.
 */

import type { ActionInputField, ActionManifest } from "../types/action";

/** Keywords that belong to the manifest, not to JSON Schema. */
const MANIFEST_ONLY = new Set(["required"]);

/** JSON Schema object for a function tool's `parameters`. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/** Translate one manifest field to a JSON Schema property. */
export function fieldSchema(field: ActionInputField): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(field)) {
    if (MANIFEST_ONLY.has(keyword) || value === undefined) continue;
    schema[keyword] = value;
  }
  // Legacy shorthand: `string[]` → array of strings.
  const match = /^(\w+)\[\]$/.exec(field.type);
  if (match) {
    schema.type = "array";
    if (schema.items === undefined) schema.items = { type: match[1] };
  }
  return schema;
}

/**
 * Build the parameters schema for a tool, minus every bound field.
 * `bind` is the step's pin map; only its keys matter here.
 */
export function toolSchema(manifest: ActionManifest, bind: Record<string, unknown> = {}): ToolParameters {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(manifest.input ?? {})) {
    if (name in bind) continue;
    properties[name] = fieldSchema(field);
    if (field.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * The input an action receives from a model's tool call: only declared,
 * unbound fields from the model's arguments, then every bound field the
 * action declares. A model-supplied value for a bound field never survives.
 */
export function toolInput(
  manifest: ActionManifest,
  modelArgs: Record<string, unknown>,
  bind: Record<string, unknown> = {},
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const name of Object.keys(manifest.input ?? {})) {
    if (name in bind) input[name] = bind[name];
    else if (name in modelArgs) input[name] = modelArgs[name];
  }
  return input;
}

/** Whether a value matches a JSON Schema primitive type name. Unknown names pass. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Check one value against a (field) schema's type and bounds. Returns an error or undefined. */
function checkValue(name: string, value: unknown, schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) return `${name} must be ${type}`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${name} must be >= ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${name} must be <= ${schema.maximum}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${name} must have at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${name} must have at most ${schema.maxLength} characters`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${name} must be one of: ${schema.enum.map(String).join(", ")}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${name} must have at most ${schema.maxItems} items`;
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      for (let i = 0; i < value.length; i++) {
        const error = checkValue(`${name}[${i}]`, value[i], items as Record<string, unknown>);
        if (error) return error;
      }
    }
  }
  return undefined;
}

/**
 * Check a model's tool arguments against the schema it was shown: type,
 * minimum / maximum, minLength / maxLength, enum, maxItems and item types, for
 * every unbound declared field the model set. Returns an error naming the
 * first offending field, or undefined. Only model-chosen values are checked
 * this way; other callers of runAction get defaults, required and enum only.
 */
export function checkToolArgs(
  manifest: ActionManifest,
  modelArgs: Record<string, unknown>,
  bind: Record<string, unknown> = {},
): string | undefined {
  for (const [name, field] of Object.entries(manifest.input ?? {})) {
    if (name in bind || !(name in modelArgs)) continue;
    const value = modelArgs[name];
    if (value === null && !field.required) continue;
    const error = checkValue(name, value, fieldSchema(field));
    if (error) return error;
  }
  return undefined;
}

/**
 * Fill declared defaults and check declared enums. Returns the completed
 * input, or an error string naming the first offending field. Legacy
 * manifests declare neither, so they pass through unchanged.
 */
export function prepareInput(
  manifest: ActionManifest,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; error?: string } {
  const completed = { ...input };
  for (const [name, field] of Object.entries(manifest.input ?? {})) {
    const value = completed[name];
    if ((value === undefined || value === null) && field.default !== undefined) {
      completed[name] = field.default;
      continue;
    }
    if (field.required && (value === undefined || value === null)) {
      return { input: completed, error: `Missing required input: ${name}` };
    }
    if (value !== undefined && value !== null && Array.isArray(field.enum) && !field.enum.includes(value)) {
      return { input: completed, error: `Input ${name} must be one of: ${field.enum.map(String).join(", ")}` };
    }
  }
  return { input: completed };
}
