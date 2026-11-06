/**
 * What an agent step's declared `returns` means: the words that ask the model
 * for only that value, and the check its answer must pass before the run goes on.
 */

import type { AgentReturnType } from "../types/agent";

const WANTED: Record<AgentReturnType, string> = {
  string: "non-empty text",
  url: "an absolute http(s) URL",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a JSON array",
  object: "a JSON object",
};

export const AGENT_RETURN_TYPES = Object.keys(WANTED) as AgentReturnType[];

export function returnInstruction(returns: AgentReturnType): string {
  return `\n\nReply with only ${WANTED[returns]}: that one value, with no other words, labels or other values around it.`;
}

const NOT_READABLE = Symbol("not readable");
type Reading = unknown | typeof NOT_READABLE;

function unwrapped(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fence?.[1] !== undefined) return fence[1].trim();
  const pair = /^(["'`<])(.*)(["'`>])$/s.exec(trimmed);
  return pair && (pair[1] === "<" ? pair[3] === ">" : pair[1] === pair[3]) ? (pair[2] ?? "").trim() : trimmed;
}

function readUrl(answer: unknown): Reading {
  if (typeof answer !== "string") return NOT_READABLE;
  const text = unwrapped(answer);
  if (/\s/.test(text) || !URL.canParse(text)) return NOT_READABLE;
  const { protocol, hostname } = new URL(text);
  return (protocol === "http:" || protocol === "https:") && hostname.length > 0 ? text : NOT_READABLE;
}

function readNumber(answer: unknown): Reading {
  const text = typeof answer === "string" ? unwrapped(answer) : answer;
  const value = typeof text === "string" && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
  return typeof value === "number" && Number.isFinite(value) ? value : NOT_READABLE;
}

function readJson(answer: unknown): Reading {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(unwrapped(answer)) as unknown;
  } catch (_err) {
    // Prose is the expected way to fail here; the caller reports it as the wrong type.
    return NOT_READABLE;
  }
}

const isPlainObject = (value: Reading): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

function read(answer: unknown, returns: AgentReturnType): Reading {
  switch (returns) {
    case "string": {
      const text = typeof answer === "string" ? answer.trim() : "";
      return text.length > 0 ? text : NOT_READABLE;
    }
    case "url":
      return readUrl(answer);
    case "number":
      return readNumber(answer);
    case "integer": {
      const value = readNumber(answer);
      return Number.isInteger(value) ? value : NOT_READABLE;
    }
    case "boolean": {
      if (typeof answer === "boolean") return answer;
      const word = typeof answer === "string" ? unwrapped(answer).toLowerCase() : "";
      return word === "true" ? true : word === "false" ? false : NOT_READABLE;
    }
    case "array": {
      const value = readJson(answer);
      return Array.isArray(value) ? value : NOT_READABLE;
    }
    case "object": {
      const value = readJson(answer);
      return isPlainObject(value) ? value : NOT_READABLE;
    }
  }
}

function excerpt(answer: unknown): string {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer) ?? String(answer);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** The answer as the declared type, or the plain reason it is not one, naming the field it was to fill. */
export function readAgentReturn(answer: unknown, returns: AgentReturnType, field: string): { value: unknown } | { reason: string } {
  const value = read(answer, returns);
  if (value !== NOT_READABLE) return { value };
  return { reason: `\`${field}\` must be ${WANTED[returns]}, but the answer was: ${excerpt(answer)}` };
}
