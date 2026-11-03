import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "yaml";
import { defaultFlowsDir, deleteFlow, listFlows, saveFlow, showFlow } from "../src/lib/saved-flows";

const ROOT = mkdtempSync(join(tmpdir(), "pulse-saved-flows-"));
const REPOS = join(ROOT, "repos");
const MARKER = join(ROOT, "ran.marker");

const FLOW = [
  "name: F_IVY_SAVED",
  "input:",
  "  text: hello",
  "actions:",
  "  - A_MARK # sovereignty: D, residency: CH",
  "",
].join("\n");

let counter = 0;
function freshDir(): string {
  counter += 1;
  return join(ROOT, `flows-${counter}`);
}

function snapshot(dir: string): Record<string, { bytes: string; mtimeMs: number }> {
  if (!existsSync(dir)) return {};
  const files: Record<string, { bytes: string; mtimeMs: number }> = {};
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    files[entry] = { bytes: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  }
  return files;
}

beforeAll(() => {
  const pkg = join(REPOS, "arc-flow-pkg");
  mkdirSync(join(pkg, "A_MARK"), { recursive: true });
  writeFileSync(join(pkg, "arc-manifest.yaml"), "name: arc-flow-pkg\nversion: 1.0.0\ntype: tool\n");
  writeFileSync(join(pkg, "flow.yaml"), "name: F_ARC_TAKEN\nsource:\n  type: inline\ndestination:\n  type: stdout\npipeline: ./pipeline.yaml\n");
  writeFileSync(join(pkg, "pipeline.yaml"), "name: P_ARC\nactions:\n  - A_MARK\n");
  writeFileSync(join(pkg, "A_MARK", "action.json"), JSON.stringify({ name: "A_MARK", version: "1.0.0", description: "Mark", input: {}, output: {}, requires: [] }));
  writeFileSync(join(pkg, "A_MARK", "action.ts"), `import { writeFileSync } from "fs";\nexport default { async execute(input) { writeFileSync(${JSON.stringify(MARKER)}, "ran"); return input; } };\n`);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("saveFlow", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    spawnSpy = spyOn(Bun, "spawn");
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterAll(() => {
    spawnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  afterEach(() => {
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(MARKER)).toBe(false);
  });

  test("saves into an empty directory with provenance and mode 0600, and reads back by name and request ID", async () => {
    const flowsDir = freshDir();
    const result = await saveFlow({ yaml: FLOW, requestId: "conv-req-0001", conversation: "conv-1", exchange: "ex-1", savedBy: "jc", flowsDir, reposDir: REPOS, now: () => new Date("2026-11-02T10:00:00Z") });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.name).toBe("F_IVY_SAVED");
    expect(result.path).toBe(join(flowsDir, "F_IVY_SAVED.yaml"));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(flowsDir).mode & 0o777).toBe(0o700);

    const text = readFileSync(result.path, "utf8");
    expect(text.startsWith(FLOW)).toBe(true);
    expect(parse(text).provenance).toEqual({ origin: "conversation", conversation: "conv-1", exchange: "ex-1", request_id: "conv-req-0001", saved_at: "2026-11-02T10:00:00.000Z", saved_by: "jc" });
    expect(readdirSync(flowsDir)).toEqual(["F_IVY_SAVED.yaml"]);

    const byName = await showFlow({ name: "F_IVY_SAVED", flowsDir, reposDir: REPOS });
    expect(byName).toMatchObject({ status: "found", source: "saved", sha256: result.sha256, yaml: text });
    const byRequest = await showFlow({ requestId: "conv-req-0001", flowsDir, reposDir: REPOS });
    expect(byRequest).toMatchObject({ status: "found", name: "F_IVY_SAVED", sha256: result.sha256 });
  });

  test("records origin cli and falls back to PULSE_PRINCIPAL without a conversation", async () => {
    const flowsDir = freshDir();
    const before = process.env.PULSE_PRINCIPAL;
    process.env.PULSE_PRINCIPAL = "principal-env";
    try {
      const result = await saveFlow({ yaml: FLOW, requestId: "cli-req-0001", flowsDir, reposDir: REPOS });
      expect(result.status).toBe("saved");
      const shown = await showFlow({ name: "F_IVY_SAVED", flowsDir, reposDir: REPOS });
      expect(shown).toMatchObject({ provenance: { origin: "cli", conversation: null, exchange: null, saved_by: "principal-env" } });
    } finally {
      if (before === undefined) delete process.env.PULSE_PRINCIPAL;
      else process.env.PULSE_PRINCIPAL = before;
    }
  });

  test("a repeated save with the same request ID and content is exists and leaves the file untouched", async () => {
    const flowsDir = freshDir();
    const first = await saveFlow({ yaml: FLOW, requestId: "conv-req-0002", conversation: "c", flowsDir, reposDir: REPOS });
    const before = snapshot(flowsDir);
    await Bun.sleep(20);
    const again = await saveFlow({ yaml: `${FLOW}\n`, requestId: "conv-req-0002", conversation: "c", flowsDir, reposDir: REPOS });
    expect(again).toEqual({ status: "exists", name: "F_IVY_SAVED", path: join(flowsDir, "F_IVY_SAVED.yaml"), sha256: first.status === "saved" ? first.sha256 : "" });
    expect(snapshot(flowsDir)).toEqual(before);
  });

  test("the same request ID with different content is a conflict and changes nothing", async () => {
    const flowsDir = freshDir();
    await saveFlow({ yaml: FLOW, requestId: "conv-req-0003", flowsDir, reposDir: REPOS });
    const before = snapshot(flowsDir);
    const result = await saveFlow({ yaml: FLOW.replace("hello", "changed"), requestId: "conv-req-0003", flowsDir, reposDir: REPOS });
    expect(result.status).toBe("conflict");
    expect(snapshot(flowsDir)).toEqual(before);
  });

  test("a new request ID with a saved flow's name is a conflict and changes nothing", async () => {
    const flowsDir = freshDir();
    await saveFlow({ yaml: FLOW, requestId: "conv-req-0004", flowsDir, reposDir: REPOS });
    const before = snapshot(flowsDir);
    const result = await saveFlow({ yaml: FLOW, requestId: "conv-req-0005", flowsDir, reposDir: REPOS });
    expect(result).toEqual({ status: "conflict", reason: "A saved flow is already named F_IVY_SAVED." });
    expect(snapshot(flowsDir)).toEqual(before);
  });

  test("a name an installed arc flow uses is a conflict and creates nothing", async () => {
    const flowsDir = freshDir();
    const result = await saveFlow({ yaml: FLOW.replace("F_IVY_SAVED", "F_ARC_TAKEN"), requestId: "conv-req-0006", flowsDir, reposDir: REPOS });
    expect(result.status).toBe("conflict");
    expect(existsSync(flowsDir)).toBe(false);
  });

  for (const [label, yaml] of [
    ["../x", FLOW.replace("F_IVY_SAVED", "../x")],
    ["f_lower", FLOW.replace("F_IVY_SAVED", "f_lower")],
    ["an empty name", FLOW.replace("F_IVY_SAVED", '""')],
    ["a provenance key", `${FLOW}provenance:\n  origin: cli\n`],
    ["a schedule key", `${FLOW}schedule:\n  cron: "0 * * * *"\n`],
    ["empty actions", "name: F_EMPTY\nactions: []\n"],
    ["a bad step shape", "name: F_BAD_STEP\nactions:\n  - mapp: {}\n"],
    ["not YAML", "name: [unclosed\n"],
  ] as const) {
    test(`input with ${label} is invalid and writes nothing`, async () => {
      const flowsDir = freshDir();
      const result = await saveFlow({ yaml, requestId: "conv-req-0007", flowsDir, reposDir: REPOS });
      expect(result.status).toBe("invalid");
      expect(existsSync(flowsDir)).toBe(false);
    });
  }

  test("a malformed request ID or a relative flows directory is invalid", async () => {
    expect((await saveFlow({ yaml: FLOW, requestId: "short", flowsDir: freshDir(), reposDir: REPOS })).status).toBe("invalid");
    expect((await saveFlow({ yaml: FLOW, requestId: "has a space!", flowsDir: freshDir(), reposDir: REPOS })).status).toBe("invalid");
    expect((await saveFlow({ yaml: FLOW, requestId: "conv-req-0008", flowsDir: "relative/flows", reposDir: REPOS })).status).toBe("invalid");
    expect(existsSync("relative")).toBe(false);
  });

  test("a flow-style document still gets a provenance mapping with the same content hash", async () => {
    const flowsDir = freshDir();
    const result = await saveFlow({ yaml: "{name: F_FLOW_STYLE, actions: [A_MARK]}", requestId: "conv-req-0009", flowsDir, reposDir: REPOS });
    expect(result.status).toBe("saved");
    const shown = await showFlow({ name: "F_FLOW_STYLE", flowsDir, reposDir: REPOS });
    expect(shown).toMatchObject({ status: "found", sha256: result.status === "saved" ? result.sha256 : "", provenance: { request_id: "conv-req-0009" } });
  });
});

describe("showFlow and listFlows", () => {
  test("show by name falls back to arc flows; show by request ID searches saved flows only", async () => {
    const flowsDir = freshDir();
    expect(await showFlow({ name: "F_ARC_TAKEN", flowsDir, reposDir: REPOS })).toMatchObject({ status: "found", source: "arc", provenance: null, path: join(REPOS, "arc-flow-pkg", "flow.yaml") });
    expect(await showFlow({ requestId: "conv-missing-1", flowsDir, reposDir: REPOS })).toEqual({ status: "not-found" });
    expect(await showFlow({ name: "F_NOWHERE", flowsDir, reposDir: REPOS })).toEqual({ status: "not-found" });
  });

  test("an unreadable flows directory is unreadable, never not-found", async () => {
    const flowsDir = freshDir();
    mkdirSync(flowsDir);
    chmodSync(flowsDir, 0o000);
    try {
      expect((await showFlow({ name: "F_NOWHERE", flowsDir, reposDir: REPOS })).status).toBe("unreadable");
      expect((await showFlow({ requestId: "conv-missing-1", flowsDir, reposDir: REPOS })).status).toBe("unreadable");
      expect((await listFlows({ flowsDir, reposDir: REPOS })).status).toBe("unreadable");
      expect((await saveFlow({ yaml: FLOW, requestId: "conv-req-0010", flowsDir, reposDir: REPOS })).status).toBe("unreadable");
    } finally {
      chmodSync(flowsDir, 0o700);
    }
  });

  test("a saved flow file that does not parse is unreadable", async () => {
    const flowsDir = freshDir();
    mkdirSync(flowsDir);
    writeFileSync(join(flowsDir, "F_BROKEN.yaml"), "name: [unclosed\n");
    expect((await showFlow({ name: "F_NOWHERE", flowsDir, reposDir: REPOS })).status).toBe("unreadable");
  });

  test("list marks saved and arc flows with their source, and gives saved flows the hash and provenance show reports", async () => {
    const flowsDir = freshDir();
    await saveFlow({ yaml: FLOW, requestId: "conv-req-0011", conversation: "conv-1", flowsDir, reposDir: REPOS });
    await saveFlow({ yaml: FLOW.replace("F_IVY_SAVED", "F_IVY_OTHER"), requestId: "conv-req-0012", flowsDir, reposDir: REPOS });
    const shown = await Promise.all(["F_IVY_OTHER", "F_IVY_SAVED"].map((name) => showFlow({ name, flowsDir, reposDir: REPOS })));
    const [other, saved] = shown.map((result) => {
      if (result.status !== "found") throw new Error(`expected found, got ${result.status}`);
      return result;
    });
    const result = await listFlows({ flowsDir, reposDir: REPOS });
    expect(result).toEqual({
      status: "ok",
      flows: [
        { name: "F_IVY_OTHER", source: "saved", path: join(flowsDir, "F_IVY_OTHER.yaml"), package: null, sha256: other.sha256, provenance: other.provenance },
        { name: "F_IVY_SAVED", source: "saved", path: join(flowsDir, "F_IVY_SAVED.yaml"), package: null, sha256: saved.sha256, provenance: saved.provenance },
        { name: "F_ARC_TAKEN", source: "arc", path: join(REPOS, "arc-flow-pkg", "flow.yaml"), package: "arc-flow-pkg", sha256: null, provenance: null },
      ],
    });
    expect(saved.provenance).toMatchObject({ origin: "conversation", conversation: "conv-1", request_id: "conv-req-0011" });
  });

  test("list gives a saved flow without a provenance key null provenance", async () => {
    const flowsDir = freshDir();
    mkdirSync(flowsDir);
    writeFileSync(join(flowsDir, "F_HAND.yaml"), "name: F_HAND\nactions:\n  - A_MARK\n");
    const result = await listFlows({ flowsDir, reposDir: REPOS });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.flows[0]).toMatchObject({ name: "F_HAND", source: "saved", provenance: null });
    expect(result.flows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("list is unreadable when any saved flow file does not parse, never a partial list", async () => {
    const flowsDir = freshDir();
    await saveFlow({ yaml: FLOW, requestId: "conv-req-0013", flowsDir, reposDir: REPOS });
    writeFileSync(join(flowsDir, "F_BROKEN.yaml"), "name: [unclosed\n");
    expect((await listFlows({ flowsDir, reposDir: REPOS })).status).toBe("unreadable");
  });

  test("the default directory follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(defaultFlowsDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/pulse/flows");
    expect(defaultFlowsDir({})).toMatch(/\.config\/pulse\/flows$/);
  });
});

describe("deleteFlow", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    spawnSpy = spyOn(Bun, "spawn");
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterAll(() => {
    spawnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  afterEach(() => {
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(MARKER)).toBe(false);
  });

  async function savedSha(flowsDir: string, requestId: string): Promise<string> {
    const saved = await saveFlow({ yaml: FLOW, requestId, flowsDir, reposDir: REPOS });
    if (saved.status !== "saved") throw new Error(`expected saved, got ${saved.status}`);
    return saved.sha256;
  }

  test("deletes a saved flow whose content matches, then a repeat is absent", async () => {
    const flowsDir = freshDir();
    const sha256 = await savedSha(flowsDir, "del-req-0001");
    expect(await deleteFlow({ name: "F_IVY_SAVED", expectedSha256: sha256, flowsDir, reposDir: REPOS })).toEqual({ status: "deleted", name: "F_IVY_SAVED", sha256 });
    expect(existsSync(join(flowsDir, "F_IVY_SAVED.yaml"))).toBe(false);
    expect(await showFlow({ name: "F_IVY_SAVED", flowsDir, reposDir: REPOS })).toEqual({ status: "not-found" });
    expect(await deleteFlow({ name: "F_IVY_SAVED", expectedSha256: sha256, flowsDir, reposDir: REPOS })).toEqual({ status: "absent", name: "F_IVY_SAVED" });
  });

  test("a missing flows directory is absent", async () => {
    expect(await deleteFlow({ name: "F_NOWHERE", expectedSha256: "a".repeat(64), flowsDir: freshDir(), reposDir: REPOS })).toEqual({ status: "absent", name: "F_NOWHERE" });
  });

  test("a stale sha256 is a conflict and leaves the file byte-identical", async () => {
    const flowsDir = freshDir();
    await savedSha(flowsDir, "del-req-0002");
    const before = snapshot(flowsDir);
    const result = await deleteFlow({ name: "F_IVY_SAVED", expectedSha256: "0".repeat(64), flowsDir, reposDir: REPOS });
    expect(result.status).toBe("conflict");
    expect(snapshot(flowsDir)).toEqual(before);
  });

  test("an installed arc flow's name is refused and the arc package is unchanged", async () => {
    const arcFlow = join(REPOS, "arc-flow-pkg", "flow.yaml");
    const before = readFileSync(arcFlow, "utf8");
    expect(await deleteFlow({ name: "F_ARC_TAKEN", expectedSha256: "a".repeat(64), flowsDir: freshDir(), reposDir: REPOS })).toEqual({
      status: "refused",
      reason: "F_ARC_TAKEN is an installed arc flow; remove it with arc.",
    });
    expect(readFileSync(arcFlow, "utf8")).toBe(before);
  });

  test.each([
    ["a path-like name", { name: "../x", expectedSha256: "a".repeat(64) }, "name"],
    ["an uppercase sha256", { name: "F_IVY_SAVED", expectedSha256: "A".repeat(64) }, "expected-sha256"],
    ["a missing sha256", { name: "F_IVY_SAVED", expectedSha256: "" }, "expected-sha256"],
  ])("%s is invalid and deletes nothing", async (_label, input, rule) => {
    const flowsDir = freshDir();
    await savedSha(flowsDir, `del-req-${rule.length}${input.name.length}0`);
    const before = snapshot(flowsDir);
    const result = await deleteFlow({ ...input, flowsDir, reposDir: REPOS });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.findings.map((finding) => finding.rule)).toContain(rule);
    expect(snapshot(flowsDir)).toEqual(before);
  });

  test("a relative flows directory is invalid", async () => {
    const result = await deleteFlow({ name: "F_IVY_SAVED", expectedSha256: "a".repeat(64), flowsDir: "relative/flows", reposDir: REPOS });
    expect(result.status).toBe("invalid");
  });

  test("a symlink named like a saved flow is invalid and neither the link nor its target is removed", async () => {
    const flowsDir = freshDir();
    mkdirSync(flowsDir);
    const outside = join(ROOT, `outside-${counter}.yaml`);
    writeFileSync(outside, "name: F_LINKED\nactions:\n  - A_MARK\n");
    symlinkSync(outside, join(flowsDir, "F_LINKED.yaml"));
    const result = await deleteFlow({ name: "F_LINKED", expectedSha256: "a".repeat(64), flowsDir, reposDir: REPOS });
    expect(result.status).toBe("invalid");
    expect(lstatSync(join(flowsDir, "F_LINKED.yaml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("name: F_LINKED\nactions:\n  - A_MARK\n");
  });

  test("an unreadable flows directory is unreadable, never absent", async () => {
    const flowsDir = freshDir();
    const sha256 = await savedSha(flowsDir, "del-req-0003");
    chmodSync(flowsDir, 0o000);
    try {
      expect((await deleteFlow({ name: "F_IVY_SAVED", expectedSha256: sha256, flowsDir, reposDir: REPOS })).status).toBe("unreadable");
      expect((await deleteFlow({ name: "F_NOWHERE", expectedSha256: sha256, flowsDir, reposDir: REPOS })).status).toBe("unreadable");
    } finally {
      chmodSync(flowsDir, 0o700);
    }
    expect(existsSync(join(flowsDir, "F_IVY_SAVED.yaml"))).toBe(true);
  });

  test("a saved flow file that does not parse is unreadable and stays", async () => {
    const flowsDir = freshDir();
    mkdirSync(flowsDir);
    writeFileSync(join(flowsDir, "F_BROKEN.yaml"), "name: [unclosed\n");
    expect((await deleteFlow({ name: "F_BROKEN", expectedSha256: "a".repeat(64), flowsDir, reposDir: REPOS })).status).toBe("unreadable");
    expect(existsSync(join(flowsDir, "F_BROKEN.yaml"))).toBe(true);
  });
});
