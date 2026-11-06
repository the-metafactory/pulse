import { describe, expect, test } from "bun:test";
import { composeFlow, type CatalogEntry } from "../src/index";
import { validatePipeline } from "../src/lib/composer/validate-pipeline";
import { readsDataFindings } from "../src/lib/composer/reads-data";

const FETCH_FEED: CatalogEntry = { name: "A_FETCH_FEED", description: "Fetch a feed", input: { feedUrl: { type: "string", required: true }, limit: { type: "number" } }, output: { items: { type: "array" }, feedTitle: { type: "string" } }, tags: ["rss", "feed", "fetch"] };
const EXTRACT: CatalogEntry = { name: "A_EXTRACT_ARTICLE", description: "Extract articles", input: { items: { type: "array", required: true } }, output: { articles: { type: "array" } }, tags: ["extract"] };
const MAIL_SEND: CatalogEntry = { name: "A_MAIL_SEND", description: "Send one mail", input: { subject: { type: "string", required: true }, body: { type: "string", required: true }, to: { type: "string" } }, output: { sent: { type: "boolean" }, sentMessageId: { type: "string" } }, tags: ["email", "send", "write"] };
const SYNC: CatalogEntry = { name: "A_PUBLISH_NOTE", description: "Publish a note", input: {}, output: { noteUrl: { type: "string" } }, tags: ["publish"] };
const CATALOG = [FETCH_FEED, EXTRACT, MAIL_SEND, SYNC];

const agent = (name: string, collect: string, prompt: string, returns = "string"): string =>
  `  - agent: # sovereignty: A, residency: CH\n      name: ${name}\n      capability: compose.judgment\n      prompt: "${prompt}"\n      collect: ${collect}\n      returns: ${returns}\n`;
const action = (name: string): string => `  - ${name} # sovereignty: D, residency: CH\n`;
const flow = (...steps: string[]): string => `name: F_HEISE\nactions:\n${steps.join("")}`;
const reply = (yaml: string): string => `\`\`\`yaml\n${yaml}\`\`\`\nA summary.`;

const FEED_URL = agent("derive-feed-url", "feedUrl", "Give the feed URL for {scenario}", "url");
const FIXED_LIMIT = "input:\n  limit: 150\n";
const LIVE_FLOW_OF_NOV_6 = flow(
  FEED_URL,
  action("A_FETCH_FEED"),
  agent("pick-yesterday", "yesterdayItems", "Keep only yesterday's articles from {items}", "array"),
  agent("write-summary", "body", "Write a summary of yesterday's heise.de articles"),
  agent("write-subject", "subject", "Write a subject for the summary of yesterday's heise.de articles"),
  action("A_MAIL_SEND"),
) + FIXED_LIMIT;
const READS_ITS_DATA = flow(
  FEED_URL,
  action("A_FETCH_FEED"),
  agent("pick-yesterday", "yesterdayItems", "Keep only yesterday's articles from {items}", "array"),
  agent("write-summary", "body", "Summarize these articles: {yesterdayItems}"),
  agent("write-subject", "subject", "Write a subject for this summary: {body}"),
  action("A_MAIL_SEND"),
) + FIXED_LIMIT;

const compose = (...replies: string[]) => {
  let next = 0;
  const prompts: string[] = [];
  const result = composeFlow("Every morning at 8, mail me a summary of yesterday's heise.de articles", {
    catalog: CATALOG,
    llm: async (prompt) => {
      prompts.push(prompt);
      return { text: replies[Math.min(next++, replies.length - 1)] ?? "" };
    },
  });
  return { result, prompts };
};
const rulesOf = (yaml: string, rule = "unread-data"): string[] => readsDataFindings(yaml, CATALOG).filter((finding) => finding.rule === rule).map((finding) => finding.message);

describe("the heise flow of 2026-11-06, which would have mailed an invented summary", () => {
  test("composing it sends the model back, naming the unread field and the step that invents", async () => {
    const { result, prompts } = compose(reply(LIVE_FLOW_OF_NOV_6), reply(READS_ITS_DATA));
    expect(await result).toMatchObject({ status: "complete", yaml: READS_ITS_DATA });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("yesterdayItems");
    expect(prompts[1]).toContain("write-summary");
  });

  test("a model that never reads the data gets no flow", async () => {
    const { result } = compose(reply(LIVE_FLOW_OF_NOV_6));
    expect(await result).toMatchObject({ status: "invalid", kind: "off-contract", findings: expect.arrayContaining([expect.objectContaining({ rule: "unread-data" })]) });
  });

  test("the fixed flow composes on the first attempt", async () => {
    const { result, prompts } = compose(reply(READS_ITS_DATA));
    expect(await result).toMatchObject({ status: "complete" });
    expect(prompts).toHaveLength(1);
  });
});

describe("an output no later step reads", () => {
  test("a fetch nothing reads is named, with the fields it writes", () => {
    const yaml = flow(FEED_URL, action("A_FETCH_FEED"), agent("write", "body", "Write about {scenario}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND"));
    expect(rulesOf(yaml)).toContainEqual(expect.stringContaining("`A_FETCH_FEED` writes `items`,"));
  });

  test("one read output is enough: a flow need not read feedTitle", () => {
    const yaml = flow(FEED_URL, action("A_FETCH_FEED"), action("A_EXTRACT_ARTICLE"));
    expect(rulesOf(yaml)).toEqual([]);
  });

  test("the last step's output is the flow's result, and a step that acts need not be read", () => {
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), agent("sum", "summary", "Summarize {items}")))).toEqual([]);
    expect(rulesOf(flow(action("A_PUBLISH_NOTE"), FEED_URL, action("A_FETCH_FEED")))).toEqual([]);
  });

  test("a manifest's write effect exempts an action as its tags do, and a map of acting steps needs no reader", () => {
    const untagged: CatalogEntry = { ...SYNC, name: "A_STORE", tags: [], effect: "write" };
    const catalog = [...CATALOG, untagged];
    expect(readsDataFindings(flow(action("A_STORE"), FEED_URL, action("A_FETCH_FEED")), catalog).filter((f) => f.rule === "unread-data")).toEqual([]);
    const sends = "  - map: # sovereignty: D, residency: CH\n      over: items\n      as: item\n      collect: receipts\n      actions:\n        - A_MAIL_SEND\n";
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), sends, agent("sum", "summary", "Summarize {items}")))).toEqual([]);
  });

  test("a map's inner fields are its own: what the map collects is what must be read", () => {
    const map = "  - map: # sovereignty: A, residency: CH\n      over: items\n      as: item\n      collect: notes\n      actions:\n        - agent:\n            name: note\n            capability: compose.judgment\n            prompt: \"Note on {item}\"\n            collect: note\n";
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), map, agent("sum", "body", "Summarize {notes}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND")))).toEqual([]);
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), map, agent("sum", "body", "Summarize {items}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND")))).toContainEqual(expect.stringContaining("`notes`"));
  });
});

describe("an agent step that must read the Payload it works from", () => {
  test("a judgment after the data that reads only the request would invent its answer, even when another step reads the data", () => {
    const yaml = flow(FEED_URL, action("A_FETCH_FEED"), agent("title", "subject", "Title for {items}"), agent("write", "body", "Write up {scenario}"), action("A_MAIL_SEND"));
    expect(rulesOf(yaml)).toContainEqual(expect.stringContaining("`write`"));
  });

  test("reading only a config value such as the feed URL is not reading the data", () => {
    const yaml = flow(FEED_URL, action("A_FETCH_FEED"), agent("title", "subject", "Title for {items}"), agent("write", "body", "Summarize the feed at {feedUrl}"), action("A_MAIL_SEND"));
    expect(rulesOf(yaml)).toContainEqual(expect.stringContaining("`write`"));
  });

  test("a judgment before any data, and a typed config step after it, read no data and are fine", () => {
    expect(rulesOf(flow(agent("write", "body", "Write up {scenario}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND")))).toEqual([]);
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), agent("how-many", "top", "How many for {scenario}?", "integer"), agent("sum", "summary", "Summarize {top} of {items}")))).toEqual([]);
  });

  test("a dotted read and a read through a derived field both count", () => {
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), agent("sum", "summary", "Lead with {items.0.title}")))).toEqual([]);
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), action("A_EXTRACT_ARTICLE"), agent("sum", "summary", "Summarize {articles}")))).toEqual([]);
  });

  test("a feed's title is not its articles", () => {
    const yaml = flow(FEED_URL, action("A_FETCH_FEED"), agent("title", "subject", "Title for {items}"), agent("write", "body", "Write a summary of {feedTitle}"), action("A_MAIL_SEND"));
    expect(rulesOf(yaml)).toContainEqual(expect.stringContaining("`write`"));
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), agent("sum", "summary", "Summarize {feedTitle}"), agent("up", "note", "Sharpen {summary}"))).join(" ")).toContain("`items`");
  });

  test("reading what an acting step reported counts: an announcement may work from the URL it published", () => {
    expect(rulesOf(flow(action("A_PUBLISH_NOTE"), FEED_URL, action("A_FETCH_FEED"), agent("sum", "body", "Sum {items}"), agent("say", "subject", "Announce {noteUrl}"), action("A_MAIL_SEND")))).toEqual([]);
  });

  test("a parallel branch does not see what a sibling branch wrote, and a declared read effect outranks a tag", () => {
    const branches = "  - parallel: # sovereignty: A, residency: CH\n      branches:\n        one:\n          actions:\n            - A_FETCH_FEED\n        two:\n          actions:\n            - agent:\n                name: sibling\n                capability: compose.judgment\n                prompt: \"Write from {scenario}\"\n                collect: note\n";
    expect(rulesOf(flow(FEED_URL, branches))).toEqual([]);
    const readsWithAPostTag: CatalogEntry = { ...FETCH_FEED, name: "A_READ_POSTS", effect: "read", tags: ["post"] };
    expect(readsDataFindings(flow(FEED_URL, action("A_READ_POSTS"), agent("a", "subject", "Up {scenario}")), [readsWithAPostTag]).map((f) => f.rule)).toContain("unread-data");
  });

  test("what an acting step reported is not data a later step must read, and an object output is data beside a scalar", () => {
    expect(rulesOf(flow(action("A_PUBLISH_NOTE"), agent("say", "body", "Write up {scenario}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND")))).toEqual([]);
    const articleWithMeta: CatalogEntry = { ...FETCH_FEED, name: "A_ARTICLE", input: {}, output: { text: { type: "string" }, metadata: { type: "object" } } };
    expect(readsDataFindings(flow(action("A_ARTICLE"), agent("sum", "summary", "Summarize {text}")), [articleWithMeta])).toEqual([]);
  });

  test("a judgment inside a map reads the item, not the collection", () => {
    const map = (prompt: string) => `  - map: # sovereignty: A, residency: CH\n      over: items\n      as: item\n      collect: notes\n      actions:\n        - agent:\n            name: note\n            capability: compose.judgment\n            prompt: "${prompt}"\n            collect: note\n`;
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), map("Note on {item}")))).toEqual([]);
    expect(rulesOf(flow(FEED_URL, action("A_FETCH_FEED"), map("Note on {scenario}")))).toContainEqual(expect.stringContaining("`note`"));
  });
});

describe("an action's limit", () => {
  const withoutLimit = flow(FEED_URL, action("A_FETCH_FEED"), agent("sum", "body", "Summarize {items}"), agent("title", "subject", "Title for {body}"), action("A_MAIL_SEND"));

  test("a flow that leaves it to the default is sent back, and one that fixes it composes", async () => {
    const { result, prompts } = compose(reply(withoutLimit), reply(`${withoutLimit}${FIXED_LIMIT}`));
    expect(await result).toMatchObject({ status: "complete", yaml: `${withoutLimit}${FIXED_LIMIT}` });
    expect(prompts[1]).toContain("`A_FETCH_FEED.limit`");
  });

  test("a typed agent step may set it instead", () => {
    const yaml = flow(FEED_URL, agent("how-many", "limit", "How many items for {scenario}?", "integer"), action("A_FETCH_FEED"), agent("sum", "summary", "Summarize {items}"));
    expect(rulesOf(yaml, "unset-limit")).toEqual([]);
  });

  test("a field a flow fixes in its input satisfies a required input", () => {
    const yaml = `${flow(action("A_FETCH_FEED"))}input:\n  feedUrl: https://news.example/feed.xml\n  limit: 150\n`;
    expect(validatePipeline(yaml, CATALOG, { initialFields: ["scenario"] }).findings).toEqual([]);
    expect(validatePipeline(flow(action("A_FETCH_FEED")), CATALOG, { initialFields: ["scenario"] }).findings).toContainEqual(expect.objectContaining({ rule: "missing-input" }));
  });
});
