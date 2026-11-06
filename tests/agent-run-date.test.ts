import { describe, expect, test } from "bun:test";
import { composeFlow, runPipeline, validateSteps, type CatalogEntry } from "../src/index";
import { MockAgentProvider } from "../src/lib/agent-provider";
import type { AgentTaskSpec } from "../src/types/agent";

const NOTE: CatalogEntry = { name: "A_NOTE", description: "Keep a note", input: { note: { type: "string", required: true } }, output: {} };
const flowWithPrompt = (prompt: string): string => `name: F_DIGEST\nactions:\n  - agent: # sovereignty: A, residency: CH\n      name: digest\n      capability: compose.judgment\n      prompt: "${prompt}"\n      collect: note\n      returns: string\n  - A_NOTE # sovereignty: D, residency: CH\n`;
const reply = (yaml: string): string => `\`\`\`yaml\n${yaml}\`\`\`\nA summary.`;

const YESTERDAY_REQUEST = "email me a summary of yesterday's heise.de articles";
const FROZEN = flowWithPrompt("Summarise the articles published on 2026-11-05 from: {scenario}");
const RELATIVE = flowWithPrompt("Summarise the articles published yesterday from: {scenario}");

function composeReplying(request: string, ...replies: string[]) {
  let next = 0;
  const prompts: string[] = [];
  const llm = async (prompt: string) => {
    prompts.push(prompt);
    return { text: replies[Math.min(next++, replies.length - 1)] ?? "" };
  };
  return { prompts, result: composeFlow(request, { catalog: [NOTE], llm }) };
}

async function promptOnRun(at: string, timeZone = "Europe/Zurich", prompt = "Summarise yesterday"): Promise<string> {
  let seen = "";
  const provider = new MockAgentProvider({ judge: (spec: AgentTaskSpec) => { seen = spec.prompt; return "done"; } });
  const result = await runPipeline({ name: "P", actions: validateSteps([{ agent: { name: "judge", capability: "judge", prompt } }]) }, {}, { actionDirs: [], agentProvider: provider, now: () => new Date(at), timeZone });
  expect(result.error).toBeUndefined();
  return seen;
}

describe("a daily routine asked about yesterday", () => {
  test("the composer sends back a flow that hard-codes the date", async () => {
    const { result, prompts } = composeReplying(YESTERDAY_REQUEST, reply(FROZEN), reply(RELATIVE));
    const composed = await result;
    expect(composed).toMatchObject({ status: "complete" });
    expect(composed.status === "complete" && composed.yaml).not.toContain("2026-11-05");
    expect(prompts[1]).toContain("frozen-date");
    expect(prompts[1]).toContain("2026-11-05");
  });

  test("a model that keeps the date gets no flow", async () => {
    expect(await composeReplying(YESTERDAY_REQUEST, reply(FROZEN)).result).toMatchObject({ status: "invalid", kind: "off-contract" });
  });

  test("two days' runs of one flow ask about two different days", async () => {
    const thursday = await promptOnRun("2026-11-05T07:00:00Z");
    const friday = await promptOnRun("2026-11-06T07:00:00Z");
    expect(thursday).toContain("Today is 2026-11-05 and yesterday was 2026-11-04");
    expect(friday).toContain("Today is 2026-11-06 and yesterday was 2026-11-05");
  });
});

describe("the date a run gives its agents", () => {
  test.each([
    ["the host's day, not UTC's", "2026-11-05T23:30:00Z", "Europe/Zurich", "2026-11-06", "2026-11-05"],
    ["behind UTC", "2026-11-06T03:00:00Z", "America/New_York", "2026-11-05", "2026-11-04"],
    ["over a month boundary", "2026-11-01T07:00:00Z", "Europe/Zurich", "2026-11-01", "2026-10-31"],
    ["over a year boundary", "2027-01-01T07:00:00Z", "Europe/Zurich", "2027-01-01", "2026-12-31"],
    ["the day after clocks go back", "2026-10-26T07:00:00Z", "Europe/Zurich", "2026-10-26", "2026-10-25"],
    ["the day after clocks go forward", "2027-03-29T07:00:00Z", "Europe/Zurich", "2027-03-29", "2027-03-28"],
  ])("%s", async (_label, at, timeZone, today, yesterday) => {
    expect(await promptOnRun(at, timeZone)).toContain(`Today is ${today} and yesterday was ${yesterday}`);
  });

  test("the whole run keeps the date it started on, even across midnight", async () => {
    const seen: string[] = [];
    const provider = new MockAgentProvider({ judge: (spec: AgentTaskSpec) => { seen.push(spec.prompt); return "done"; } });
    const clock = ["2026-11-05T22:59:00Z", "2026-11-05T23:01:00Z"];
    const steps = [{ agent: { name: "a", capability: "judge", prompt: "first", collect: "a" } }, { agent: { name: "b", capability: "judge", prompt: "second", collect: "b" } }];
    await runPipeline({ name: "P", actions: validateSteps(steps) }, {}, { actionDirs: [], agentProvider: provider, now: () => new Date(clock.shift() ?? "2026-11-05T23:59:00Z"), timeZone: "Europe/Zurich" });
    expect(seen).toHaveLength(2);
    for (const prompt of seen) expect(prompt).toContain("Today is 2026-11-05");
  });

  test("the prompt the flow wrote stays intact behind the date", async () => {
    expect(await promptOnRun("2026-11-06T07:00:00Z", "Europe/Zurich", "Judge {missing:text} now")).toEndWith("Judge {missing:text} now");
  });
});

describe("what counts as a frozen date", () => {
  test.each([
    "published on 2026-11-05",
    "published on November 5th",
    "published on 5 May from the feed",
    "published on 05.11.2026.",
    "published on 05.11.2026",
    "published on 5.11.2026",
    "published on 11/05/2026",
    "published on November 5, 2026",
    "published on Nov 5",
    "published on 5 November 2026",
    "published on 5. November 2026",
    "erschienen am 5. Dezember",
    "published on the 5th of November",
  ])("%s", async (prompt) => {
    expect(await composeReplying(YESTERDAY_REQUEST, reply(flowWithPrompt(prompt))).result).toMatchObject({ status: "invalid" });
  });

  test.each([
    "published yesterday",
    "keep the 15 newest of 2026 budget lines",
    "use version 1.2.3 and 10.0.0.1",
    "may contain marked items",
    "the top 5 may be dropped",
    "the host at 10.1.10.20",
  ])("not: %s", async (prompt) => {
    expect(await composeReplying(YESTERDAY_REQUEST, reply(flowWithPrompt(prompt))).result).toMatchObject({ status: "complete" });
  });

  test("a date the request itself names stays", async () => {
    const yaml = flowWithPrompt("Summarise the articles published on 2026-11-05");
    expect(await composeReplying("mail me a summary of the heise.de articles from November 5", reply(yaml)).result).toMatchObject({ status: "complete" });
  });

  test("a date frozen in the flow's input counts too", async () => {
    const yaml = `${flowWithPrompt("Summarise yesterday")}input:\n  since: 2026-11-05\n`;
    expect(await composeReplying(YESTERDAY_REQUEST, reply(yaml)).result).toMatchObject({ status: "invalid" });
  });
});
