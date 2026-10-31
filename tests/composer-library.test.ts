import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFlow, type CatalogEntry } from "../src/index";
import { buildCatalog } from "../src/lib/composer/catalog";

const catalog: CatalogEntry[] = [
  { name: "A_FETCH", description: "Fetch newsletter links", input: {}, output: { links: { type: "array" } } },
  { name: "A_ADD", description: "Add links", input: { links: { type: "array", required: true } }, output: {} },
];
const yaml = "name: F_NEWS\nactions:\n  - A_FETCH # sovereignty: D, residency: CH\n  - A_ADD # sovereignty: D, residency: CH\n";
const response = `\`\`\`yaml\n${yaml}\`\`\`\nFetch and add links.`;
const dir = await mkdtemp(join(tmpdir(), "pulse-compose-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("composeFlow returns a parsed catalog-valid pipeline without executing actions", async () => {
  const result = await composeFlow("fetch and add links", { catalog, llm: async () => ({ text: response }) });
  expect(result.status).toBe("complete");
  if (result.status === "complete") expect(result.flow).toMatchObject({ name: "F_NEWS", actions: ["A_FETCH", "A_ADD"] });
});

test("missing capability is named in a typed refusal; no invented flow escapes", async () => {
  const result = await composeFlow("send by carrier pigeon", {
    catalog,
    llm: async () => ({ text: response.replace("A_ADD", "A_PIGEON") }),
    maxRetries: 0,
  });
  expect(result.status).toBe("no-match");
  if (result.status === "no-match") expect(result.message).toContain("A_PIGEON");
  expect("yaml" in result).toBe(false);
});

test("explicit missing capability refusal stays a refusal", async () => {
  const result = await composeFlow("send a fax", { catalog, llm: async () => ({ text: "Closest I have is A_ADD; the gap is fax delivery. Pivot to storing links?" }) });
  expect(result).toMatchObject({ status: "no-match", kind: "missing-capability" });
});

test.each(["unrelated prose", "", "```yaml\nname: F_PARTIAL\nactions: []\n```", "```yaml\nactions:\n  - A_FETCH # sovereignty: D, residency: CH\n```"])("off-contract answer returns typed failure: %s", async (text) => {
  const result = await composeFlow("fetch links", { catalog, llm: async () => ({ text }), maxRetries: 0 });
  expect(result.status).toBe("invalid");
  expect("yaml" in result).toBe(false);
});

test("model transport failure is typed", async () => {
  expect(await composeFlow("fetch", { catalog, llm: async () => { throw new Error("model unavailable"); } })).toMatchObject({ status: "invalid", kind: "composition-failed" });
});

test("nested unknown actions cannot bypass the catalog", async () => {
  const text = "```yaml\nname: F_NESTED\nactions:\n  - map: # sovereignty: D, residency: CH\n      over: links\n      as: link\n      collect: results\n      actions: [A_NOT_INSTALLED]\n```";
  const result = await composeFlow("fetch links", { catalog, llm: async () => ({ text }), maxRetries: 0 });
  expect(result.status).toBe("no-match");
});

test("CLI JSON matches the library using a real HTTP model boundary and catalog directory", async () => {
  for (const entry of catalog) {
    await mkdir(join(dir, entry.name));
    await writeFile(join(dir, entry.name, "action.json"), JSON.stringify(entry));
    await writeFile(join(dir, entry.name, "action.ts"), 'throw new Error("compose must not execute actions")');
  }
  expect(await buildCatalog(dir)).toHaveLength(2);
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: response } }] }) });
  try {
    const proc = Bun.spawn(["bun", "src/cli.ts", "compose", "--request", "fetch and add links", "--json", "--catalog-dir", dir, "--model-url", `http://127.0.0.1:${server.port}/v1`, "--model", "fixture"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PULSE_COMPOSE_API_KEY: "fixture" }, stdout: "pipe", stderr: "pipe" });
    const actual = await new Response(proc.stdout).json();
    expect(await proc.exited).toBe(0);
    const expected = await composeFlow("fetch and add links", { catalog, llm: async () => ({ text: response }) });
    expect(actual).toEqual(expected);
  } finally {
    server.stop(true);
  }
});


test("agent steps supply named fields without invented actions", async () => {
  const text = "```yaml\nname: F_AGENT\nactions:\n  - agent: # sovereignty: A, residency: CH\n      name: judge\n      capability: compose.judgment\n      prompt: Assess {scenario}\n      collect: links\n  - A_ADD # sovereignty: D, residency: CH\n```";
  expect(await composeFlow("judge links", { catalog, llm: async () => ({ text }) })).toMatchObject({ status: "complete" });
});

test.each([-1, 3, NaN])("retry budgets are bounded: %s", async (maxRetries) => {
  expect(await composeFlow("fetch", { catalog, llm: async () => { throw new Error("must not call model"); }, maxRetries })).toMatchObject({ status: "invalid", kind: "composition-failed" });
});


test("malformed model steps followed by a spurious capability refusal retain off-contract provenance", async () => {
  let calls = 0;
  const llm = async () => ({ text: ++calls === 1 ? "```yaml\nname: F_BAD\nactions:\n  - A_FETCH: {} # sovereignty: D, residency: CH\n```" : "Closest I have is A_FETCH; the gap is an action shape the validator accepts. Pivot to another request?" });
  const result = await composeFlow("fetch", { catalog, llm });
  expect(result).toMatchObject({ status: "invalid", kind: "off-contract" });
  expect("yaml" in result).toBe(false);
});
