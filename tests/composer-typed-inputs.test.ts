import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { composeFlow, runPipeline, validateSteps, type CatalogEntry } from "../src/index";
import { MockAgentProvider } from "../src/lib/agent-provider";
import { validateStep } from "../src/lib/step-runner";
import { typedInputFindings } from "../src/lib/composer/typed-inputs";
import type { AgentTaskSpec } from "../src/types/agent";

const FETCH_FEED: CatalogEntry = { name: "A_FETCH_FEED", description: "Fetch a feed", input: { feedUrl: { type: "string", required: true }, limit: { type: "number" } }, output: { items: { type: "array" } } };
const EXTRACT: CatalogEntry = { name: "A_EXTRACT_ARTICLE", description: "Extract articles", input: { items: { type: "array", required: true } }, output: { articles: { type: "array" } } };
const NOTE: CatalogEntry = { name: "A_NOTE", description: "Keep a note", input: { note: { type: "string", required: true }, unread: { type: "boolean" }, top: { type: "integer" }, meta: { type: "object" } }, output: {} };
const CATALOG = [FETCH_FEED, EXTRACT, NOTE];

const agent = (name: string, collect: string, returns?: string, prompt = `Infer ${collect} from {scenario}`): string =>
  `  - agent: # sovereignty: A, residency: CH\n      name: ${name}\n      capability: compose.judgment\n      prompt: "${prompt}"\n      collect: ${collect}\n${returns ? `      returns: ${returns}\n` : ""}`;
const action = (name: string): string => `  - ${name} # sovereignty: D, residency: CH\n`;
const flow = (...steps: string[]): string => `name: F_HEISE\nactions:\n${steps.join("")}`;
const reply = (yaml: string): string => `\`\`\`yaml\n${yaml}\`\`\`\nA summary.`;

const AS_SEEN_ON_NOV_3 = flow(agent("derive-feed-config", "feedUrl", undefined, "Infer the heise.de RSS feed URL and item limit (default 15) from: {scenario}"), action("A_FETCH_FEED"));
const ONE_STEP_PER_INPUT = flow(agent("derive-feed-url", "feedUrl", "url"), agent("derive-limit", "limit", "number"), action("A_FETCH_FEED"));

let actionDir: string;
let ranWith: string;

beforeAll(async () => {
  actionDir = await mkdtemp(join(tmpdir(), "pulse-typed-inputs-"));
  ranWith = join(actionDir, "ran-with.json");
  const dir = join(actionDir, "A_FETCH_FEED");
  await mkdir(dir);
  await writeFile(join(dir, "action.json"), JSON.stringify(FETCH_FEED));
  await writeFile(join(dir, "action.ts"), `export default { async execute(input) { await Bun.write(${JSON.stringify(ranWith)}, JSON.stringify(input)); return { ...input, items: [] }; } };`);
});
afterAll(() => rm(actionDir, { recursive: true, force: true }));

function composeReplying(...replies: string[]) {
  let next = 0;
  const prompts: string[] = [];
  const llm = async (prompt: string) => {
    prompts.push(prompt);
    return { text: replies[Math.min(next++, replies.length - 1)] ?? "" };
  };
  return { prompts, result: composeFlow("email me a summary of the last days article on heise.de", { catalog: CATALOG, llm }) };
}

async function runComposed(yaml: string, answers: Record<string, unknown>) {
  await rm(ranWith, { force: true });
  const doc = parse(yaml) as { name: string; actions: unknown[] };
  const dispatched: AgentTaskSpec[] = [];
  const provider = new MockAgentProvider({ "compose.judgment": (spec: AgentTaskSpec) => {
    dispatched.push(spec);
    const answer = Object.entries(answers).find(([marker]) => spec.prompt.includes(marker));
    return answer?.[1] ?? null;
  } });
  const result = await runPipeline({ name: doc.name, actions: validateSteps(doc.actions) }, { scenario: "the last days article on heise.de" }, { actionDirs: [actionDir], agentProvider: provider });
  return { result, dispatched, actionRan: await Bun.file(ranWith).exists() };
}

describe("the 2026-11-03 heise flow", () => {
  test("composing it sends the model back: the judgment feeds feedUrl with no declared type", async () => {
    const { result, prompts } = composeReplying(reply(AS_SEEN_ON_NOV_3), reply(ONE_STEP_PER_INPUT));
    expect(await result).toMatchObject({ status: "complete", flow: { actions: [{ agent: { collect: "feedUrl", returns: "url" } }, { agent: { collect: "limit", returns: "number" } }, "A_FETCH_FEED"] } });
    expect(prompts[1]).toContain("feedUrl");
    expect(prompts[1]).toContain("returns: url");
  });

  test("a model that never declares the type gets no flow", async () => {
    const { result } = composeReplying(reply(AS_SEEN_ON_NOV_3));
    expect(await result).toMatchObject({ status: "invalid", kind: "off-contract" });
  });

  test("the composed flow answered in prose fails at the judgment, naming feedUrl, and the action never runs", async () => {
    const { result, dispatched, actionRan } = await runComposed(ONE_STEP_PER_INPUT, { feedUrl: "The heise.de RSS feed is at https://www.heise.de/rss/heise-atom.xml and the limit is 15." });
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent:derive-feed-url");
    expect(result.error).toContain("`feedUrl` must be an absolute http(s) URL");
    expect(actionRan).toBe(false);
    expect(dispatched).toHaveLength(1);
  });

  test.each([
    ["the URL with the limit behind it", "https://www.heise.de/rss/heise-atom.xml 15"],
    ["both inputs as one object", { feedUrl: "https://www.heise.de/rss/heise-atom.xml", limit: 15 }],
    ["both inputs as JSON text", '{"feedUrl":"https://www.heise.de/rss/heise-atom.xml","limit":15}'],
  ])("a judgment cannot pack two inputs into one value: %s", async (_label, answer) => {
    const { result, actionRan } = await runComposed(ONE_STEP_PER_INPUT, { feedUrl: answer });
    expect(result.error).toContain("`feedUrl`");
    expect(actionRan).toBe(false);
  });

  test("each input gets its own value of its own type", async () => {
    const { result, actionRan } = await runComposed(ONE_STEP_PER_INPUT, { feedUrl: " https://www.heise.de/rss/heise-atom.xml\n", limit: "15" });
    expect(result.success).toBe(true);
    expect(actionRan).toBe(true);
    expect(await Bun.file(ranWith).json()).toMatchObject({ feedUrl: "https://www.heise.de/rss/heise-atom.xml", limit: 15 });
  });

  test("the step asks for only the value, whatever prompt the model wrote", async () => {
    const { dispatched } = await runComposed(ONE_STEP_PER_INPUT, { feedUrl: "https://www.heise.de/rss/heise-atom.xml", limit: 15 });
    expect(dispatched[0]?.prompt).toContain("Reply with only an absolute http(s) URL");
    expect(dispatched[1]?.prompt).toContain("Reply with only a number");
  });
});

describe("an agent step's declared return", () => {
  const run = async (returns: string, output: unknown) => {
    const provider = new MockAgentProvider({ judge: output });
    const step = { agent: { name: "judge", capability: "judge", prompt: "Judge", collect: "value", returns } };
    return runPipeline({ name: "P", actions: validateSteps([step]) }, {}, { actionDirs: [], agentProvider: provider });
  };

  test.each([
    ["url", "`https://example.test/feed`", "https://example.test/feed"],
    ["url", "http://example.test", "http://example.test"],
    ["string", "  a summary\n", "a summary"],
    ["number", "1.5", 1.5],
    ["number", 3, 3],
    ["integer", "15", 15],
    ["boolean", "True", true],
    ["boolean", false, false],
    ["array", [{ link: "x" }], [{ link: "x" }]],
    ["array", '[{"link":"x"}]', [{ link: "x" }]],
    ["array", '```json\n[{"link":"x"}]\n```', [{ link: "x" }]],
    ["object", '{"a":1}', { a: 1 }],
  ])("%s accepts %j", async (returns, output, value) => {
    const result = await run(returns, output);
    expect(result.error).toBeUndefined();
    expect(result.output?.value).toEqual(value);
  });

  test.each([
    ["url", "see https://example.test/feed"],
    ["url", "www.example.test/feed"],
    ["url", "ftp://example.test/feed"],
    ["url", "javascript:alert(1)"],
    ["url", null],
    ["string", ""],
    ["string", { text: "not a string" }],
    ["number", "fifteen"],
    ["number", "15 items"],
    ["number", ""],
    ["integer", "1.5"],
    ["boolean", "yes"],
    ["array", "Here are the articles: one, two."],
    ["array", '{"a":1}'],
    ["object", "[1]"],
    ["object", null],
  ])("%s refuses %j and names the field", async (returns, output) => {
    const result = await run(returns, output);
    expect(result.success).toBe(false);
    expect(result.error).toContain("`value` must be");
    expect(result.output?.value).toBeUndefined();
  });

  test("an unknown return type is refused when the flow is read", () => {
    expect(() => validateStep({ agent: { name: "a", capability: "c", prompt: "p", returns: "email" } }, "step")).toThrow(/returns/);
  });

  test("an agent step that declares nothing keeps its answer as it came", async () => {
    const provider = new MockAgentProvider({ judge: { verdict: "free form" } });
    const result = await runPipeline({ name: "P", actions: validateSteps([{ agent: { name: "judge", capability: "judge", prompt: "Judge", collect: "value" } }]) }, {}, { actionDirs: [], agentProvider: provider });
    expect(result.output?.value).toEqual({ verdict: "free form" });
  });
});

describe("what the composer holds a flow to", () => {
  const rules = (...steps: string[]) => typedInputFindings(flow(...steps), CATALOG);

  test("every declared input type is covered, not only the feed URL", () => {
    expect(rules(agent("pick", "items"), action("A_EXTRACT_ARTICLE"))[0]?.message).toContain("returns: array");
    expect(rules(agent("n", "note"), action("A_NOTE"))[0]?.message).toContain("returns: string");
    expect(rules(agent("u", "unread"), action("A_NOTE"))[0]?.message).toContain("returns: boolean");
    expect(rules(agent("t", "top"), action("A_NOTE"))[0]?.message).toContain("returns: integer");
    expect(rules(agent("m", "meta"), action("A_NOTE"))[0]?.message).toContain("returns: object");
  });

  test("a declared return that does not suit the input is refused", () => {
    expect(rules(agent("u", "feedUrl", "string"), action("A_FETCH_FEED"))[0]?.message).toContain("returns: url");
    expect(rules(agent("i", "items", "string"), action("A_EXTRACT_ARTICLE"))).toHaveLength(1);
  });

  test("a narrower return suits a wider input", () => {
    expect(rules(agent("u", "note", "url"), action("A_NOTE"))).toEqual([]);
    expect(rules(agent("l", "limit", "integer"), agent("u", "feedUrl", "url"), action("A_FETCH_FEED"))).toEqual([]);
  });

  test("a consumer inside a primitive counts, and a map over the field needs an array", () => {
    const nested = "  - retry: # sovereignty: D, residency: CH\n      attempts: 2\n      actions: [A_EXTRACT_ARTICLE]\n";
    expect(rules(agent("pick", "items"), nested)).toHaveLength(1);
    const map = "  - map: # sovereignty: D, residency: CH\n      over: picks\n      as: item\n      collect: done\n      actions: [A_NOTE]\n";
    expect(rules(agent("pick", "picks"), map)[0]?.message).toContain("returns: array");
  });

  test("research output is free text, so it may fill a text input but not a typed one", () => {
    const research = "  - research: # sovereignty: A, residency: CH\n      name: dig\n      model: m\n      prompt: Dig\n      tools: [A_EXTRACT_ARTICLE]\n      collect: FIELD\n";
    expect(rules(research.replace("FIELD", "note"), action("A_NOTE"))).toEqual([]);
    expect(rules(research.replace("FIELD", "items"), action("A_EXTRACT_ARTICLE"))[0]?.rule).toBe("untyped-input");
  });

  test("a step that overwrites the field ends the judgment's reach", () => {
    const refill = "  - map: # sovereignty: D, residency: CH\n      over: other\n      as: item\n      collect: items\n      actions: []\n";
    expect(rules(agent("draft", "items"), refill, action("A_EXTRACT_ARTICLE"))).toEqual([]);
  });

  test("a step around a reader does not hide it, even when it collects the same field", () => {
    const around = "  - map: # sovereignty: D, residency: CH\n      over: other\n      as: item\n      collect: items\n      actions: [A_EXTRACT_ARTICLE]\n";
    expect(rules(agent("draft", "items"), around)[0]?.message).toContain("returns: array");
  });

  test("a judgment inside retry still reaches the steps after it", () => {
    const nested = "  - retry: # sovereignty: D, residency: CH\n      attempts: 2\n      actions:\n        - agent: { name: pick, capability: c, prompt: p, collect: items }\n";
    expect(rules(nested, action("A_EXTRACT_ARTICLE"))[0]?.message).toContain("returns: array");
  });

  test("what a map's children write stays inside the map, so the judgment still reaches the step after it", () => {
    const writesItemsInside = "  - map: # sovereignty: D, residency: CH\n      over: other\n      as: item\n      collect: done\n      actions: [A_FEED_ITEMS]\n";
    const catalog = [...CATALOG, { name: "A_FEED_ITEMS", description: "Writes items", input: {}, output: { items: { type: "array" } } }];
    expect(typedInputFindings(flow(agent("pick", "items"), writesItemsInside, action("A_EXTRACT_ARTICLE")), catalog)[0]?.message).toContain("A_EXTRACT_ARTICLE.items");
  });

  test("a judgment inside a map reaches its siblings but not the steps after the map", () => {
    const inside = "  - map: # sovereignty: D, residency: CH\n      over: other\n      as: item\n      collect: done\n      actions:\n        - agent: { name: pick, capability: c, prompt: p, collect: items }\n";
    expect(rules(inside, action("A_EXTRACT_ARTICLE"))).toEqual([]);
    expect(rules(`${inside}        - A_EXTRACT_ARTICLE\n`)[0]?.message).toContain("returns: array");
  });

  test("two maps inside one retry do not share what they write", () => {
    const mapOf = (actions: string) => `        - map:\n            over: other\n            as: item\n            collect: done\n            actions:\n${actions}`;
    const writes = "              - agent: { name: pick, capability: c, prompt: p, collect: items }\n";
    const reads = "              - A_EXTRACT_ARTICLE\n";
    const around = `  - retry: # sovereignty: D, residency: CH\n      attempts: 2\n      actions:\n${mapOf(writes)}${mapOf(reads)}`;
    expect(rules(around)).toEqual([]);
  });

  test("a judgment inside a map reaches a reader in a map nested beside it", () => {
    const around = "  - map: # sovereignty: D, residency: CH\n      over: other\n      as: item\n      collect: done\n      actions:\n        - agent: { name: pick, capability: c, prompt: p, collect: items }\n        - map:\n            over: other\n            as: inner\n            collect: innerDone\n            actions: [A_EXTRACT_ARTICLE]\n";
    expect(rules(around)[0]?.message).toContain("A_EXTRACT_ARTICLE.items");
  });

  test("what a parallel branch writes stays in that branch", () => {
    const parallel = "  - parallel: # sovereignty: D, residency: CH\n      branches:\n        first:\n          actions:\n            - agent: { name: pick, capability: c, prompt: p, collect: items }\n        second:\n          actions: [A_EXTRACT_ARTICLE]\n";
    expect(rules(parallel)).toEqual([]);
  });

  test("a judgment nothing reads needs no type", () => {
    expect(rules(agent("muse", "thought"))).toEqual([]);
  });
});
