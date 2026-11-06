import { describe, expect, test } from "bun:test";
import { composeFlow, runPipeline, validateSteps, type CatalogEntry } from "../src/index";
import { windowFindings } from "../src/lib/composer/window";
import { MockAgentProvider } from "../src/lib/agent-provider";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FETCH_FEED: CatalogEntry = {
  name: "A_FETCH_FEED",
  description: "Fetch a feed",
  input: { feedUrl: { type: "string", required: true }, limit: { type: "number" }, window: { type: "string" } },
  output: { items: { type: "array" }, windowDay: { type: "string" }, windowZone: { type: "string" }, windowNote: { type: "string" } },
  tags: ["rss", "feed", "fetch"],
};
const PLAIN_FEED: CatalogEntry = { name: "A_PLAIN_FEED", description: "Fetch a feed", input: { feedUrl: { type: "string", required: true }, limit: { type: "number" } }, output: { items: { type: "array" } } };
const NOTICE: CatalogEntry = {
  name: "A_WINDOW_NOTICE",
  description: "Report the window",
  input: { body: { type: "string", required: true }, items: { type: "array", required: true }, windowDay: { type: "string", required: true }, windowZone: { type: "string", required: true }, windowNote: { type: "string", required: true } },
  output: { body: { type: "string" } },
};
const MAIL_SEND: CatalogEntry = { name: "A_MAIL_SEND", description: "Send one mail", input: { subject: { type: "string", required: true }, body: { type: "string", required: true } }, output: { sent: { type: "boolean" } }, tags: ["email", "send", "write"] };
const CATALOG = [FETCH_FEED, PLAIN_FEED, NOTICE, MAIL_SEND];

const flowOf = (options: { feed?: string; prompt?: string; input?: string; notice?: boolean }): string =>
  `name: F_DAILY
actions:
  - ${options.feed ?? "A_FETCH_FEED"} # sovereignty: A, residency: frontier
  - agent: # sovereignty: A, residency: CH
      name: summarize
      capability: compose.judgment
      prompt: "${options.prompt ?? "Summarize these articles: {items}"}"
      collect: body
      returns: string
${options.notice === false ? "" : "  - A_WINDOW_NOTICE # sovereignty: D, residency: CH\n"}  - A_MAIL_SEND # sovereignty: D, residency: CH
input:
  feedUrl: https://example.test/feed
  limit: 150
  subject: Daily
${options.input ?? ""}`;
const WINDOW = "  window: yesterday\n";
const YESTERDAY_REQUEST = "mail me a summary of yesterday's example.test articles";
const rules = (request: string, yaml: string): string[] => windowFindings(request, yaml, CATALOG).map((finding) => finding.message);

describe("a date-relative flow over a feed that has a window", () => {
  test("the live routine's flow, with no window, goes back", () => {
    const [message] = rules(YESTERDAY_REQUEST, flowOf({ prompt: "Here are the feed items: {items}. Identify which ones were published yesterday.", notice: false }));
    expect(message).toContain("window: yesterday");
  });

  test("a flow with the window and its report passes", () => {
    expect(rules(YESTERDAY_REQUEST, flowOf({ input: WINDOW }))).toEqual([]);
  });

  test("a prompt about yesterday counts when the request does not name a day", () => {
    expect(rules("mail me a daily digest", flowOf({ prompt: "Summarize yesterday's articles among {items}" }))[0]).toContain("window: yesterday");
  });

  test("a German request counts", () => {
    expect(rules("Schick mir die Artikel von gestern", flowOf({}))[0]).toContain("window: yesterday");
  });

  test("a window with no report goes back, so an empty or partial day cannot pass unsaid", () => {
    expect(rules(YESTERDAY_REQUEST, flowOf({ input: WINDOW, notice: false }))[0]).toContain("A_WINDOW_NOTICE");
  });

  test("a relative day no window offers is told to say so", () => {
    expect(rules("mail me last week's articles", flowOf({}))[0]).toContain("Closest I have");
  });

  test("a relative day no window offers goes back even when a window is set", () => {
    expect(rules("mail me last week's articles", flowOf({ input: WINDOW }))[0]).toContain("Closest I have");
  });

  test("the day before yesterday is not yesterday", () => {
    expect(rules("mail me the articles from the day before yesterday", flowOf({ input: WINDOW }))[0]).toContain("Closest I have");
  });

  test("a relative day in a prompt counts when the request names none", () => {
    expect(rules("mail me a daily digest", flowOf({ prompt: "Summarize today's articles among {items}" }))[0]).toContain("Closest I have");
  });

  test("a word about when to send does not turn a request about yesterday away", () => {
    expect(rules("mail me yesterday's articles today at 7", flowOf({ input: WINDOW }))).toEqual([]);
    expect(rules("Schick mir heute die Artikel von gestern", flowOf({ input: WINDOW }))).toEqual([]);
  });

  test("a report after the delivery comes too late", () => {
    const late = flowOf({ input: WINDOW, notice: false }).replace("  - A_MAIL_SEND # sovereignty: D, residency: CH\n", "  - A_MAIL_SEND # sovereignty: D, residency: CH\n  - A_WINDOW_NOTICE # sovereignty: D, residency: CH\n");
    expect(rules(YESTERDAY_REQUEST, late)[0]).toContain("A_WINDOW_NOTICE");
  });

  test("a request with no relative day needs no window", () => {
    expect(rules("mail me a summary of the latest articles", flowOf({ prompt: "Summarize the newest of {items}", notice: false }))).toEqual([]);
  });

  test("a feed action with no window input is left alone", () => {
    expect(rules(YESTERDAY_REQUEST, flowOf({ feed: "A_PLAIN_FEED", notice: false }))).toEqual([]);
  });

  test("the composer sends the flow back and accepts the windowed one", async () => {
    const replies = [flowOf({ notice: false }), flowOf({ input: WINDOW })].map((yaml) => `\`\`\`yaml\n${yaml}\`\`\`\nA summary.`);
    const prompts: string[] = [];
    const llm = async (prompt: string) => {
      prompts.push(prompt);
      return { text: replies[Math.min(prompts.length - 1, 1)] ?? "" };
    };
    const composed = await composeFlow(YESTERDAY_REQUEST, { catalog: CATALOG, llm });
    expect(composed).toMatchObject({ status: "complete" });
    expect(composed.status === "complete" && composed.yaml).toContain("window: yesterday");
    expect(prompts[1]).toContain("unset-window");
  });

  test("the composer's instructions lead a day's items to the window and a bare body", async () => {
    const prompts: string[] = [];
    await composeFlow(YESTERDAY_REQUEST, { catalog: CATALOG, maxRetries: 0, llm: async (prompt: string, options?: { system?: string }) => {
      prompts.push(`${options?.system ?? ""}\n${prompt}`);
      return { text: `\`\`\`yaml\n${flowOf({ input: WINDOW })}\`\`\`\nA summary.` };
    } });
    const told = prompts.join("\n");
    expect(told).toContain("sets window: yesterday");
    expect(told).toContain("sign-off");
    expect(told).not.toContain("Summarize yesterday's articles among these");
  });
});

describe("an action's view of the run", () => {
  function actionDirWithClockAction(): string {
    const root = mkdtempSync(join(tmpdir(), "pulse-run-clock-"));
    mkdirSync(join(root, "A_CLOCK"));
    writeFileSync(join(root, "A_CLOCK", "action.json"), JSON.stringify({ name: "A_CLOCK", version: "1.0.0", description: "Reads the run clock", input: {}, output: {} }));
    writeFileSync(join(root, "A_CLOCK", "action.ts"), "export default { async execute(_input, ctx) { return { seenAt: ctx.run.startedAt.toISOString(), seenZone: ctx.run.timeZone }; } };\n");
    return root;
  }

  test("an action reads the clock and zone the run's prompts state, even across midnight", async () => {
    const ticks = ["2026-11-05T22:59:59.900Z", "2026-11-05T23:00:01.000Z"];
    let read = 0;
    let prompt = "";
    const provider = new MockAgentProvider({ judge: (spec: { prompt: string }) => { prompt = spec.prompt; return "done"; } });
    const result = await runPipeline(
      { name: "P", actions: validateSteps(["A_CLOCK", { agent: { name: "judge", capability: "judge", prompt: "Which day?" } }]) },
      {},
      { actionDirs: [actionDirWithClockAction()], agentProvider: provider, now: () => new Date(ticks[Math.min(read++, 1)]!), timeZone: "Europe/Zurich" },
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toMatchObject({ seenAt: "2026-11-05T22:59:59.900Z", seenZone: "Europe/Zurich" });
    expect(prompt).toContain("Today is 2026-11-05 and yesterday was 2026-11-04");
  });
});
