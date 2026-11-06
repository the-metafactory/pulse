import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFlow, type CatalogEntry } from "../src/index";
import type { ComposerLLM } from "../src/lib/composer/compose";
import type { DeliveryAsk } from "../src/lib/composer/delivery";

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
const NOTES = reply(flow(agent("note")));

const asks = (channels: string[], extra: Partial<DeliveryAsk> = {}): DeliveryAsk => ({ channels, send: channels.length > 0, mailsSomeoneElse: false, ...extra });
const EMAIL_ME = asks(["email"]);
const POST_DISCORD = asks(["discord"]);

function model(ask: DeliveryAsk | string, ...compositions: string[]): { llm: ComposerLLM; prompts: string[]; asked: () => number } {
  const prompts: string[] = [];
  let reads = 0;
  let next = 0;
  const llm: ComposerLLM = async (prompt, options) => {
    if (options?.json) {
      reads++;
      return { text: typeof ask === "string" ? ask : JSON.stringify(ask) };
    }
    prompts.push(prompt);
    return { text: compositions[Math.min(next++, compositions.length - 1)] ?? "" };
  };
  return { llm, prompts, asked: () => reads };
}
const compose = (request: string, catalog: CatalogEntry[], m: ReturnType<typeof model>) => composeFlow(request, { catalog, llm: m.llm, holdToDelivery: true });

describe("reading the delivery a request asks for", () => {
  test("the reading sees the request but not the catalog, so what is installed cannot bend it", async () => {
    let seen = "";
    const llm: ComposerLLM = async (prompt, options) => {
      if (options?.json) { seen = `${options.system}${prompt}`; return { text: JSON.stringify(EMAIL_ME) }; }
      return { text: MAILS };
    };
    await composeFlow("email me a summary", { catalog: WITH_SEND, llm, holdToDelivery: true });
    expect(seen).toContain("email me a summary");
    expect(seen).not.toContain("A_MAIL_SEND");
  });

  test("an unreadable reading stops the composition instead of skipping the check", async () => {
    const m = model("not json", MAILS);
    const result = await compose("email me a summary", WITH_SEND, m);
    expect(result).toMatchObject({ status: "invalid", kind: "composition-failed" });
    expect(m.prompts).toHaveLength(0);
  });

  test("a reading with extra fields is refused", async () => {
    const result = await compose("email me", WITH_SEND, model(JSON.stringify({ ...EMAIL_ME, extra: 1 }), MAILS));
    expect(result).toMatchObject({ status: "invalid", kind: "composition-failed" });
  });

  test("a caller that does not ask for the check makes no extra model call", async () => {
    const m = model(EMAIL_ME, SWAPS_TO_DISCORD);
    const result = await composeFlow("email bob@example.com a summary", { catalog: WITH_SEND, llm: m.llm });
    expect(result.status).toBe("complete");
    expect(m.asked()).toBe(0);
  });
});

describe("a request for email", () => {
  test("composes to the send action when the catalog has one", async () => {
    const result = await compose("email me a summary", WITH_SEND, model(EMAIL_ME, MAILS));
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.yaml).toContain("A_MAIL_SEND");
  });

  test("names the gap and composes nothing when the catalog cannot send mail", async () => {
    const m = model(EMAIL_ME, SWAPS_TO_DISCORD);
    const result = await compose("email me a summary", WITHOUT_SEND, m);
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") {
      expect(result.message).toContain("can't deliver by email");
      expect(result.message).toContain("Discord instead");
    }
    expect(m.prompts).toHaveLength(0);
  });

  test("a mail-reading action does not count as being able to send mail", async () => {
    expect((await compose("mail me the summary", [MAIL_READ], model(EMAIL_ME, MAILS))).status).toBe("no-match");
  });

  test("sends the model back when it swaps the channel, and takes the corrected flow", async () => {
    const m = model(EMAIL_ME, SWAPS_TO_DISCORD, MAILS);
    expect((await compose("email me a summary", WITH_SEND, m)).status).toBe("complete");
    expect(m.prompts).toHaveLength(2);
    expect(m.prompts[1]).toContain("missing-delivery");
  });

  test("refuses on the card when the model keeps swapping the channel", async () => {
    const result = await compose("email me a summary", WITH_SEND, model(EMAIL_ME, SWAPS_TO_DISCORD));
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("email");
  });

  test("refuses an extra post on a channel nobody asked for", async () => {
    const both = reply(flow(agent("summary"), action("A_FORMAT_DISCORD"), agent("subject"), agent("body"), action("A_MAIL_SEND")));
    const result = await compose("email me a summary", WITH_SEND, model(EMAIL_ME, both));
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("A_FORMAT_DISCORD");
  });

  test("refuses a send that is not the last step", async () => {
    const early = reply(flow(agent("subject"), agent("body"), action("A_MAIL_SEND"), agent("note")));
    expect((await compose("email me a summary", WITH_SEND, model(EMAIL_ME, early))).status).toBe("no-match");
  });

  test("accepts a send nested in the last step", async () => {
    const nested = reply(flow(agent("subject"), agent("body"), "  - retry: # sovereignty: D, residency: CH\n      attempts: 2\n      actions: [A_MAIL_SEND]\n"));
    expect((await compose("email me a summary", WITH_SEND, model(EMAIL_ME, nested))).status).toBe("complete");
  });
});

describe("a request to mail someone else", () => {
  test("is refused before the flow is composed", async () => {
    const m = model(asks(["email"], { mailsSomeoneElse: true }), MAILS);
    const result = await compose("email the team a summary", WITH_SEND, m);
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("only your own");
    expect(m.prompts).toHaveLength(0);
  });

  test("a flow that chooses the recipient itself is refused with no retry, so it cannot quietly mail the principal instead", async () => {
    const chooses = reply(flow(agent("to"), agent("subject"), agent("body"), action("A_MAIL_SEND")));
    const m = model(EMAIL_ME, chooses, MAILS);
    const result = await compose("mail the people on the list", WITH_SEND, m);
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("only your own");
    expect(m.prompts).toHaveLength(1);
  });

  test("a flow that fixes the recipient in its input is refused", async () => {
    const fixed = reply(`${flow(agent("subject"), agent("body"), action("A_MAIL_SEND"))}input:\n  to: someone@example.com\n`);
    expect((await compose("mail me a summary", WITH_SEND, model(EMAIL_ME, fixed))).status).toBe("no-match");
  });
});

describe("a request for Discord", () => {
  test("ends with the step that sends", async () => {
    const result = await compose("post a summary to Discord", WITH_SEND, model(POST_DISCORD, POSTS));
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.yaml.trimEnd().split("\n").at(-1)).toContain("A_DELIVER");
  });

  test("a formatter alone does not count as sending", async () => {
    const m = model(POST_DISCORD, SWAPS_TO_DISCORD);
    expect((await compose("post a summary to Discord", WITH_SEND, m)).status).toBe("no-match");
    expect(m.prompts[1]).toContain("A_DELIVER");
  });

  test("names the gap when nothing can post there", async () => {
    const result = await compose("post a summary to Discord", [MAIL_SEND, FORMAT_DISCORD], model(POST_DISCORD, SWAPS_TO_DISCORD));
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("can't deliver by Discord");
  });
});

describe("other readings", () => {
  test("two channels must both send, and one of them ends the flow", async () => {
    const both = reply(flow(agent("summary"), agent("subject"), agent("body"), action("A_MAIL_SEND"), action("A_DELIVER")));
    expect((await compose("send it by email and post it to Discord", WITH_SEND, model(asks(["email", "discord"]), both))).status).toBe("complete");
    expect((await compose("send it by email and post it to Discord", WITH_SEND, model(asks(["email", "discord"]), POSTS))).status).toBe("no-match");
  });

  test("a channel no action knows is named on the card", async () => {
    const result = await compose("send it by pigeon", WITH_SEND, model(asks(["pigeon"]), MAILS));
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.message).toContain("can't deliver by pigeon");
  });

  test("a send with no channel named leaves the pick to the model, but it must send", async () => {
    const unnamed = asks([], { send: true });
    expect((await compose("send me a summary", WITH_SEND, model(unnamed, MAILS))).status).toBe("complete");
    expect((await compose("send me a summary", WITH_SEND, model(unnamed, POSTS))).status).toBe("complete");
    expect((await compose("send me a summary", WITH_SEND, model(unnamed, SWAPS_TO_DISCORD))).status).toBe("no-match");
  });

  test("a request for no delivery is not held to one, and may not grow one", async () => {
    expect((await compose("summarize my email", WITHOUT_SEND, model(asks([]), NOTES))).status).toBe("complete");
    expect((await compose("summarize my email", WITH_SEND, model(asks([]), MAILS))).status).toBe("no-match");
  });
});

describe("pulse compose --json", () => {
  const dir = mkdtemp(join(tmpdir(), "pulse-delivery-"));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  test("holds the routine composer to the check and carries the gap in message with exit 1, the shape the Desk card reads", async () => {
    const catalogDir = await dir;
    for (const entry of WITHOUT_SEND) {
      await mkdir(join(catalogDir, entry.name), { recursive: true });
      await writeFile(join(catalogDir, entry.name, "action.json"), JSON.stringify(entry));
    }
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: JSON.stringify(EMAIL_ME) } }] }) });
    try {
      const proc = Bun.spawn(["bun", "src/cli.ts", "compose", "--request", "email me a summary", "--json", "--catalog-dir", catalogDir, "--model-url", `http://127.0.0.1:${server.port}/v1`, "--model", "fixture"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PULSE_COMPOSE_API_KEY: "fixture" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout) as { status: string; message: string };
      expect(parsed.status).toBe("no-match");
      expect(parsed.message).toContain("can't deliver by email");
    } finally {
      server.stop(true);
    }
  });
});
