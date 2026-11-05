import { parse } from "yaml";
import { validateSteps } from "../step-runner";
import type { PipelineStep } from "../../types/pipeline";
import { childActions, stepOutputs, type CatalogEntry, type Finding } from "./validate-pipeline";

const MAIL = "(?:[Ee]-?[Mm]ail|[Mm]aile?)";
const MYSELF = "(?:me|myself|mir|mich)";
const ADDRESS = "[^\\s@,;<>]+@[^\\s@,;<>]+\\.[A-Za-z]{2,}";
const SELF_TARGET = new RegExp(`\\b${MAIL}\\s+${MYSELF}\\b`);
const NOT_A_RECIPIENT_NOUN = "(?:inbox|e-?mail|mail|address|account|own|work|private|personal)\\b";

const ASKS_EMAIL = [
  SELF_TARGET,
  new RegExp(`(?:^|[,;:.]\\s*|\\b(?:and|then|please|und|dann)\\s+)${MAIL}\\s+(?!(?:from|in|about|with|for|and|or|threads?|accounts?|inbox)\\b)\\S`),
  /\b(?:by|via|per|over)\s+e-?mail\b/i,
  /\bas\s+an?\s+e-?mail\b/i,
  /\bsend\s+(?:\S+\s+)?an?\s+e-?mail\b/i,
  /\bto\s+my\s+(?:inbox|e-?mail|mail)\b/i,
];
const NAMES_OTHER_RECIPIENT = [
  new RegExp(`\\b${MAIL}\\s+(?:${ADDRESS}|[A-Z][\\w-]*)`),
  new RegExp(`\\b${MAIL}\\s+(?:the|my|our)\\s+\\w+\\s+(?:a|an|the|this|my|our)\\b`),
  new RegExp(`\\bto\\s+(?:${ADDRESS}|(?:the|our)\\s+\\w+|my\\s+(?!${NOT_A_RECIPIENT_NOUN})\\w+|[A-Z][\\w-]*)\\s*(?:[.,;!?]|$)`),
];
const SELF_AND_OTHER = new RegExp(`\\b${MAIL}\\s+${MYSELF}\\s+(?:and|und)\\s+(?:${ADDRESS}|[A-Z]|(?:the|my|our)\\s)`);
const COPIES_SOMEONE = /\b(?:cc|bcc)\b/i;

const chatChannel = (tag: string, label: string) => ({
  tags: [tag],
  label,
  asked: [new RegExp(`\\b(?:post|send|publish|share|deliver|announce)\\b[^.;]*\\b${tag}\\b`, "i"), new RegExp(`\\b(?:to|via)\\s+${tag}\\b`, "i")],
});
const CHANNELS = [
  { tags: ["email", "mail"], label: "email", asked: ASKS_EMAIL },
  chatChannel("discord", "Discord"),
  chatChannel("slack", "Slack"),
  chatChannel("mattermost", "Mattermost"),
  chatChannel("telegram", "Telegram"),
];
type Channel = (typeof CHANNELS)[number];
const EMAIL = CHANNELS[0]!;

const SENDS = ["send", "deliver", "post", "publish"];
const REACHES_OUT = [...SENDS, "notify"];

export const ONLY_OWN_ADDRESSES = "A routine can mail only your own configured addresses, so it cannot mail anyone else. Ask it to \"mail me\" if the mail is for you.";

const hasTag = (entry: CatalogEntry | undefined, tags: string[]): boolean => tags.some((tag) => entry?.tags?.includes(tag));
const sendsOn = (entry: CatalogEntry | undefined, channel: Channel): boolean => hasTag(entry, channel.tags) && hasTag(entry, SENDS);
const reachesOutOn = (entry: CatalogEntry | undefined, channel: Channel): boolean => hasTag(entry, channel.tags) && hasTag(entry, REACHES_OUT);
const askedChannels = (request: string): Channel[] => CHANNELS.filter((channel) => channel.asked.some((pattern) => pattern.test(request)));

function namesOtherRecipient(request: string): boolean {
  if (COPIES_SOMEONE.test(request) || SELF_AND_OTHER.test(request)) return true;
  return !SELF_TARGET.test(request) && NAMES_OTHER_RECIPIENT.some((pattern) => pattern.test(request));
}

/** Why a request cannot be delivered with this catalog, in words for the card, or null when it can. */
export function deliveryGap(request: string, catalog: CatalogEntry[]): string | null {
  const asked = askedChannels(request);
  const missing = asked.find((channel) => !catalog.some((entry) => sendsOn(entry, channel)));
  if (missing) {
    const others = CHANNELS.filter((channel) => channel !== missing && catalog.some((entry) => sendsOn(entry, channel))).map((channel) => channel.label);
    const instead = others.length > 0 ? ` It can deliver by ${others.join(" or ")} instead, if you ask for that.` : "";
    return `A routine can't deliver by ${missing.label} yet: no installed action sends it.${instead}`;
  }
  return asked.includes(EMAIL) && namesOtherRecipient(request) ? ONLY_OWN_ADDRESSES : null;
}

function flatten(step: PipelineStep): PipelineStep[] {
  return typeof step === "string" ? [step] : [step, ...childActions(step).flat().flatMap(flatten)];
}
const actionNames = (step: PipelineStep): string[] => flatten(step).filter((s): s is string => typeof s === "string");

function readFlow(yaml: string): { steps: PipelineStep[]; input: Record<string, unknown> } {
  const doc = parse(yaml) as { actions: unknown[]; input?: Record<string, unknown> };
  return { steps: validateSteps(doc.actions), input: doc.input ?? {} };
}

/** What a composed flow gets wrong about the delivery its request names; the model is sent back to fix these. */
export function deliveryFindings(request: string, yaml: string, catalog: CatalogEntry[]): Finding[] {
  const asked = askedChannels(request);
  if (asked.length === 0) return [];
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const { steps } = readFlow(yaml);
  const names = steps.flatMap(actionNames);
  const findings: Finding[] = [];
  const finding = (step: number, message: string) => findings.push({ rule: "missing-delivery", step, message });
  for (const channel of asked) {
    if (names.some((name) => sendsOn(byName.get(name), channel))) continue;
    const senders = catalog.filter((entry) => sendsOn(entry, channel)).map((entry) => entry.name);
    finding(-1, `the request asks for delivery by ${channel.label}, but no step sends it; send it with ${senders.join(" or ")}`);
  }
  const lastStep = steps.length - 1;
  const last = steps[lastStep];
  const endsBySending = last !== undefined && actionNames(last).some((name) => asked.some((channel) => sendsOn(byName.get(name), channel)));
  if (findings.length === 0 && !endsBySending) finding(lastStep, "the flow must end with the step that sends the delivery the request asks for");
  steps.forEach((step, index) => {
    for (const name of actionNames(step)) {
      const other = CHANNELS.find((channel) => !asked.includes(channel) && reachesOutOn(byName.get(name), channel));
      if (other) finding(index, `\`${name}\` reaches ${other.label}, which the request did not ask for; remove it`);
    }
  });
  return findings;
}

/** True when a flow that sends mail sets the recipient itself instead of leaving it to the action's own default. */
export function choosesMailRecipient(yaml: string, catalog: CatalogEntry[]): boolean {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const { steps, input } = readFlow(yaml);
  const all = steps.flatMap(flatten);
  if (!all.some((step) => typeof step === "string" && sendsOn(byName.get(step), EMAIL))) return false;
  return "to" in input || all.some((step) => typeof step !== "string" && stepOutputs(step, byName).includes("to"));
}
