import type { PipelineStep } from "../../types/pipeline";
import { flatten, readFlow } from "./delivery";
import { actsOnTheWorld } from "./reads-data";
import type { CatalogEntry, Finding } from "./validate-pipeline";

const WINDOW_INPUT = "window";
const WINDOW_REPORT_INPUT = "windowNote";
const YESTERDAY_VALUE = "yesterday";
const ASKS_FOR_YESTERDAY = /\b(?:yesterday|gestern|gestrig\w*)\b/i;
const ASKS_FOR_OTHER_RELATIVE_DAY = /\b(?:today|heute|heutig\w*|last (?:night|week|month)|this (?:week|month)|past \d+ (?:days|weeks)|letzte[nr]? woche|diese[rn]? woche|day before yesterday|vorgestern)\b/i;
const DAY_BEFORE_YESTERDAY = /\bday before yesterday\b/gi;

const actionNames = (steps: PipelineStep[]): string[] => steps.flatMap(flatten).filter((step): step is string => typeof step === "string");

function agentPrompts(steps: PipelineStep[]): string[] {
  return steps.flatMap(flatten).flatMap((step) => (typeof step !== "string" && "agent" in step ? [step.agent.prompt] : []));
}

/**
 * This is a lint over the words a request or prompt uses, not a date parser. Every finding can be cleared by changing the flow, so no word forces a refusal; a request naming yesterday and another day is read as yesterday and loses the other day.
 * It holds a flow to the one window that exists; a relative day no window offers is left to the composer's instructions.
 * Whether an action can narrow by day, and what reads its report, comes from the catalog, so a feed with no window input is left alone.
 * A model cannot be relied on to select by date, so a date-relative flow over a windowed action goes back until code does the selecting.
 */
export function windowFindings(request: string, yaml: string, catalog: CatalogEntry[]): Finding[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const { steps, input } = readFlow(yaml);
  const names = actionNames(steps);
  const windowed = names.filter((name) => byName.get(name)?.input[WINDOW_INPUT]);
  if (windowed.length === 0) return [];

  const aboutYesterday = ASKS_FOR_YESTERDAY.test([request, ...agentPrompts(steps)].join("\n").replace(DAY_BEFORE_YESTERDAY, ""));
  const requestNamesAnotherDay = ASKS_FOR_OTHER_RELATIVE_DAY.test(request) && !ASKS_FOR_YESTERDAY.test(request.replace(DAY_BEFORE_YESTERDAY, ""));
  const findings: Finding[] = [];
  const finding = (message: string) => findings.push({ rule: "unset-window", step: -1, message });
  const label = windowed.join(", ");

  if (aboutYesterday && !requestNamesAnotherDay && input[WINDOW_INPUT] !== YESTERDAY_VALUE) {
    finding(`this flow is about yesterday's items, and a model cannot be relied on to select by date. Set window: ${YESTERDAY_VALUE} under the top-level input: map, so that ${label} keeps only that day's items`);
  }
  if (input[WINDOW_INPUT] !== undefined && requestNamesAnotherDay) {
    finding(`the request is not about yesterday, and window: ${YESTERDAY_VALUE} would deliver only that day. Remove the window, or use the Closest I have reply if the request needs a day no window offers`);
  }

  if (input[WINDOW_INPUT] !== undefined) {
    const reporters = catalog.filter((entry) => entry.input[WINDOW_REPORT_INPUT]).map((entry) => entry.name);
    const firstDelivery = names.findIndex((name) => actsOnTheWorld(byName.get(name)));
    const reportAt = names.findIndex((name) => reporters.includes(name));
    const reportedInTime = reportAt !== -1 && (firstDelivery === -1 || reportAt < firstDelivery);
    if (reporters.length > 0 && !reportedInTime) {
      finding(`a window can come up empty or cover only part of the day, and a model may not say so. Put ${reporters.join(" or ")} after the step that writes the result and before the step that delivers it`);
    }
  }
  return findings;
}
