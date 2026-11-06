import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFlow, composeScenario, type CatalogEntry } from "../src/index";
import type { ComposerLLM } from "../src/lib/composer/compose";

const MAIL_SEND: CatalogEntry = { name: "A_MAIL_SEND", description: "Send one mail", input: { subject: { type: "string", required: true }, body: { type: "string", required: true }, to: { type: "string" } }, output: { sent: { type: "boolean" } }, tags: ["email", "send", "write"] };
const MAIL_READ: CatalogEntry = { name: "A_MAIL_READ", description: "Read one mail", input: {}, output: { subject: { type: "string" }, body: { type: "string" } }, tags: ["email", "read"] };
const FORMAT_DISCORD: CatalogEntry = { name: "A_FORMAT_DISCORD", description: "Format a digest for Discord", input: { summary: { type: "string", required: true } }, output: { digest: { type: "string" } }, tags: ["discord", "format", "notify"] };
const DELIVER: CatalogEntry = { name: "A_DELIVER", description: "Post to Discord", input: { summary: { type: "string", required: true } }, output: { posted: { type: "boolean" } }, tags: ["discord", "file", "deliver"] };
const WITH_SEND = [MAIL_SEND, MAIL_READ, FORMAT_DISCORD, DELIVER];
const WITHOUT_SEND = [MAIL_READ, FORMAT_DISCORD, DELIVER];

const agent = (collect: string): string => `  - agent: # sovereignty: A, residency: CH\n      name: derive-${collect}\n      capability: compose.judgment\n      prompt: "Derive ${collect} from {scenario}"\n      collect: ${collect}\n`;
const flow = (...steps: string[]): string => `name: F_TEST\nactions:\n${steps.join("")}`;
const action = (name: string): string => `  - ${name} # sovereignty: D, residency: CH\n`;
const reply = (yaml: string): string => `\`\`\`yaml\n${yaml}\`\`\`\nA summary.`;

const MAILS = reply(flow(agent("subject"), agent("body"), action("A_MAIL_SEND")));
const SWAPS_TO_DISCORD = reply(flow(agent("summary"), action("A_FORMAT_DISCORD")));
const POSTS = reply(flow(agent("summary"), action("A_FORMAT_DISCORD"), action("A_DELIVER")));

function replies(...texts: string[]): { llm: ComposerLLM; prompts: string[] } {
  const prompts: string[] = [];
  let next = 0;
  return { prompts, llm: async (prompt) => { prompts.push(prompt); return { text: texts[Math.min(next++, texts.length - 1)] ?? "" }; } };
}
const mustNotCallModel: ComposerLLM = async () => { throw new Error("the model must not be asked"); };

describe("a request that names email", () => {
  test("composes to the send action when the catalog has one", async () => {
    const result = await composeFlow("email me a summary of yesterday's articles", { catalog: WITH_SEND, llm: replies(MAILS).llm });
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.yaml).toContain("A_MAIL_SEND");
  });

  test("names the gap and composes nothing when the catalog cannot send mail", async () => {
    const result = await composeFlow("email me a summary of yesterday's articles", { catalog: WITHOUT_SEND, llm: mustNotCallModel });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") {
      expect(result.message).toContain("can't deliver by email");
      expect(result.message).toContain("Discord instead");
    }
  });

  test("a mail-reading action does not count as being able to send mail", async () => {
    const result = await composeFlow("mail me the summary", { catalog: [MAIL_READ], llm: mustNotCallModel });
    expect(result.status).toBe("no-match");
  });

  test("sends the model back when it swaps the channel, and takes the corrected flow", async () => {
    const model = replies(SWAPS_TO_DISCORD, MAILS);
    const result = await composeFlow("email me a summary", { catalog: WITH_SEND, llm: model.llm });
    expect(result.status).toBe("complete");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("missing-delivery");
  });

  test("refuses on the card when the model keeps swapping the channel", async () => {
    const result = await composeFlow("email me a summary", { catalog: WITH_SEND, llm: replies(SWAPS_TO_DISCORD).llm });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("email");
  });

  test("refuses an extra post on a channel nobody asked for", async () => {
    const both = reply(flow(agent("summary"), action("A_FORMAT_DISCORD"), agent("subject"), agent("body"), action("A_MAIL_SEND")));
    const result = await composeFlow("email me a summary", { catalog: WITH_SEND, llm: replies(both).llm });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("A_FORMAT_DISCORD");
  });

  test("refuses a send that is not the last step", async () => {
    const early = reply(flow(agent("subject"), agent("body"), action("A_MAIL_SEND"), agent("note")));
    expect((await composeFlow("email me a summary", { catalog: WITH_SEND, llm: replies(early).llm })).status).toBe("no-match");
  });

  test("accepts a send nested in the last step", async () => {
    const nested = reply(flow(agent("subject"), agent("body"), "  - retry: # sovereignty: D, residency: CH\n      attempts: 2\n      actions: [A_MAIL_SEND]\n"));
    expect((await composeFlow("email me a summary", { catalog: WITH_SEND, llm: replies(nested).llm })).status).toBe("complete");
  });
});

describe("a request to mail someone else", () => {
  for (const request of [
    "email bob@example.com a summary",
    "mail Alice the report",
    "email the team a summary",
    "email my boss the digest",
    "mail the summary to the team",
    "send an email to carol@example.com",
    "mail a summary to Dana.",
    "mail me a summary and cc Erin",
    "mail me and Frank a summary",
    "email bob a summary",
    "mail me a summary and send it to Bob.",
  ]) {
    test(`refuses "${request}" before asking the model`, async () => {
      const result = await composeFlow(request, { catalog: WITH_SEND, llm: mustNotCallModel });
      expect(result.status).toBe("no-match");
      if (result.status === "no-match") expect(result.message).toContain("only your own");
    });
  }

  for (const request of [
    "email me a summary of what bob@example.com sent",
    "mail me a summary of the last days article on heise.de",
    "mail the summary to me",
    "email the digest to my work address",
    "send me an email with the digest",
    "summarize the feed and send it by email",
    "send me a summary email",
    "email me what people post on Discord",
    "send me a summary of the Slack threads by email",
    "send me a summary of the threads on Slack by email",
    "send me an email digest this morning",
  ]) {
    test(`still composes "${request}"`, async () => {
      expect((await composeFlow(request, { catalog: WITH_SEND, llm: replies(MAILS).llm })).status).toBe("complete");
    });
  }

  test("refuses a flow that chooses the recipient itself", async () => {
    const chooses = reply(flow(agent("to"), agent("subject"), agent("body"), action("A_MAIL_SEND")));
    const model = replies(chooses, MAILS);
    const result = await composeFlow("mail the people on the list", { catalog: WITH_SEND, llm: model.llm });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("only your own");
    expect(model.prompts).toHaveLength(1);
  });

  test("refuses a flow that fixes the recipient in its input", async () => {
    const fixed = reply(`${flow(agent("subject"), agent("body"), action("A_MAIL_SEND"))}input:\n  to: someone@example.com\n`);
    expect((await composeFlow("mail me a summary", { catalog: WITH_SEND, llm: replies(fixed).llm })).status).toBe("no-match");
  });
});

describe("a request that names Discord", () => {
  test("ends with the step that sends", async () => {
    const result = await composeFlow("post a summary to Discord", { catalog: WITH_SEND, llm: replies(POSTS).llm });
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.yaml.trimEnd().split("\n").at(-1)).toContain("A_DELIVER");
  });

  test("a formatter alone does not count as sending", async () => {
    const model = replies(SWAPS_TO_DISCORD);
    const result = await composeFlow("post a summary to Discord", { catalog: WITH_SEND, llm: model.llm });
    expect(result.status).toBe("no-match");
    expect(model.prompts[1]).toContain("A_DELIVER");
  });

  test("names the gap when nothing can post there", async () => {
    const result = await composeFlow("post a summary to Discord", { catalog: [MAIL_SEND, FORMAT_DISCORD], llm: mustNotCallModel });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("can't deliver by Discord");
  });
});

describe("a request that names two channels", () => {
  test("a chat channel with an article is not a mail recipient", async () => {
    const both = reply(flow(agent("summary"), agent("subject"), agent("body"), action("A_DELIVER"), action("A_MAIL_SEND")));
    expect((await composeFlow("email me the digest and send it to the Discord channel", { catalog: WITH_SEND, llm: replies(both).llm })).status).toBe("complete");
  });

  test("is not read as mailing someone called Discord", async () => {
    const both = reply(flow(agent("summary"), agent("subject"), agent("body"), action("A_MAIL_SEND"), action("A_DELIVER")));
    expect((await composeFlow("send it by email and post it to Discord", { catalog: WITH_SEND, llm: replies(both).llm })).status).toBe("complete");
  });
});

describe("a request that names no delivery", () => {
  for (const request of [
    "summarize my email",
    "search mail for invoices",
    "read mail from the bank",
    "count the threads on discord",
    "every day collect the feed",
  ]) {
    test(`is not held to one: "${request}"`, async () => {
      const yaml = reply(flow(agent("note")));
      expect((await composeFlow(request, { catalog: WITHOUT_SEND, llm: replies(yaml).llm })).status).toBe("complete");
    });
  }
});

describe("a phrasing the request reading misses", () => {
  test("still cannot swap away from the channel it mentions", async () => {
    const result = await composeFlow("drop a summary in my mailbox", { catalog: WITH_SEND, llm: replies(SWAPS_TO_DISCORD).llm });
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("did not ask for");
  });

  test("a request that mentions no channel leaves the pick to the model, in steps the card shows", async () => {
    for (const text of [MAILS, SWAPS_TO_DISCORD]) {
      const model = replies(text);
      expect((await composeFlow("send me a summary", { catalog: WITH_SEND, llm: model.llm })).status).toBe("complete");
      expect(model.prompts).toHaveLength(1);
    }
  });

  test("a channel the request names as its source may be used", async () => {
    expect((await composeFlow("format the threads on discord", { catalog: WITH_SEND, llm: replies(SWAPS_TO_DISCORD).llm })).status).toBe("complete");
  });
});

describe("the library surfaces around the check", () => {
  const dir = mkdtemp(join(tmpdir(), "pulse-delivery-"));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  test("composeScenario keeps its own recipients: the demo is not a routine", async () => {
    const blocksDir = await mkdtemp(join(await dir, "scenario-"));
    await mkdir(join(blocksDir, MAIL_SEND.name), { recursive: true });
    await writeFile(join(blocksDir, MAIL_SEND.name, "action.json"), JSON.stringify(MAIL_SEND));
    const result = await composeScenario("email bob@example.com a summary", { llm: replies(MAILS).llm, blocksDir });
    expect(result.status).toBe("complete");
  });

  test("carries the gap in message with exit 1, the shape the Desk card reads", async () => {
    const catalogDir = await dir;
    for (const entry of WITHOUT_SEND) {
      await mkdir(join(catalogDir, entry.name), { recursive: true });
      await writeFile(join(catalogDir, entry.name, "action.json"), JSON.stringify(entry));
    }
    const proc = Bun.spawn(["bun", "src/cli.ts", "compose", "--request", "email me a summary", "--json", "--catalog-dir", catalogDir, "--model-url", "http://127.0.0.1:9/v1", "--model", "fixture"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PULSE_COMPOSE_API_KEY: "fixture" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { status: string; message: string };
    expect(parsed.status).toBe("no-match");
    expect(parsed.message).toContain("can't deliver by email");
  });
});
