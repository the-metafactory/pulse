import { parse } from "yaml";
import type { Finding } from "./validate-pipeline";

const MONTH = "(?:january|jan|februar|february|feb|march|märz|maerz|mar|april|apr|may|mai|june|juni|jun|july|juli|jul|august|aug|september|sept|sep|october|oktober|oct|okt|november|nov|december|dezember|dec|dez)";
const DATE_SHAPES = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b(?![.\d])/,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}\\b`, "i"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?${MONTH}\\b`, "i"),
];

const namedDate = (text: string): string | null => {
  for (const shape of DATE_SHAPES) {
    const match = shape.exec(text);
    if (match) return match[0];
  }
  return null;
};

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value instanceof Date) return [value.toISOString().slice(0, 10)];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}

/** A calendar date the request did not name is the composer's own "today": a routine would keep using that day forever. */
export function frozenDateFindings(request: string, yaml: string): Finding[] {
  if (namedDate(request)) return [];
  return strings(parse(yaml)).flatMap((text) => {
    const date = namedDate(text);
    return date ? [{ rule: "frozen-date" as const, step: -1, message: `\`${date}\` is a fixed date the request did not name, and a routine would use it on every run; say it in words such as "yesterday", because every agent step is told today's date when it runs` }] : [];
  });
}
