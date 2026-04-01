import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  discoverArcActions,
  discoverArcPipelines,
  createArcActionDirs,
} from "../src/lib/arc";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-arc");
const REPOS_DIR = join(TEST_DIR, "repos");
const PIPELINES_DIR = join(TEST_DIR, "pipelines");
const DB_PATH = join(TEST_DIR, "packages.db");

beforeAll(() => {
  mkdirSync(REPOS_DIR, { recursive: true });
  mkdirSync(PIPELINES_DIR, { recursive: true });

  // Create a mock arc database
  const db = new Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    install_path TEXT NOT NULL,
    skill_dir TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    artifact_type TEXT DEFAULT 'skill',
    tier TEXT DEFAULT 'custom',
    customization_path TEXT,
    install_source TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name TEXT NOT NULL,
    type TEXT,
    value TEXT NOT NULL,
    reason TEXT,
    FOREIGN KEY (skill_name) REFERENCES skills(name)
  )`);

  // Package 1: a tool with actions
  const pkg1Dir = join(REPOS_DIR, "rss-tools");
  mkdirSync(pkg1Dir, { recursive: true });
  db.run(
    `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["rss-tools", "1.0.0", "https://github.com/example/rss-tools", pkg1Dir, pkg1Dir, "active", "tool", "2026-04-01", "2026-04-01"]
  );

  // Actions in package 1
  const fetchDir = join(pkg1Dir, "A_FETCH_RSS");
  mkdirSync(fetchDir, { recursive: true });
  writeFileSync(join(fetchDir, "action.json"), JSON.stringify({
    name: "A_FETCH_RSS", version: "1.0.0", description: "Fetch RSS",
    input: { url: { type: "string", required: true } },
    output: { items: { type: "array" } }, requires: ["fetch"],
  }));
  writeFileSync(join(fetchDir, "action.ts"),
    `export default { async execute(input) { return { ...input, items: [] }; } };`
  );

  const parseDir = join(pkg1Dir, "A_PARSE_ITEM");
  mkdirSync(parseDir, { recursive: true });
  writeFileSync(join(parseDir, "action.json"), JSON.stringify({
    name: "A_PARSE_ITEM", version: "1.0.0", description: "Parse item",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(parseDir, "action.ts"),
    `export default { async execute(input) { return input; } };`
  );

  // Package 2: disabled (should be skipped)
  const pkg2Dir = join(REPOS_DIR, "disabled-pkg");
  mkdirSync(pkg2Dir, { recursive: true });
  db.run(
    `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["disabled-pkg", "1.0.0", "https://github.com/example/disabled", pkg2Dir, pkg2Dir, "disabled", "tool", "2026-04-01", "2026-04-01"]
  );
  const disabledAction = join(pkg2Dir, "A_SHOULD_NOT_APPEAR");
  mkdirSync(disabledAction, { recursive: true });
  writeFileSync(join(disabledAction, "action.json"), JSON.stringify({
    name: "A_SHOULD_NOT_APPEAR", version: "1.0.0", description: "Hidden",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(disabledAction, "action.ts"),
    `export default { async execute(input) { return input; } };`
  );

  // Package 3: a pipeline
  const pkg3Dir = join(REPOS_DIR, "digest-pipeline");
  mkdirSync(pkg3Dir, { recursive: true });
  db.run(
    `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["digest-pipeline", "1.0.0", "https://github.com/example/digest", pkg3Dir, pkg3Dir, "active", "pipeline", "2026-04-01", "2026-04-01"]
  );
  writeFileSync(join(pkg3Dir, "pipeline.yaml"),
    `name: P_DIGEST\ndescription: A digest pipeline\nactions:\n  - A_FETCH_RSS\n  - A_PARSE_ITEM\n`
  );
  // Bundled actions in the pipeline package
  const pFetchDir = join(pkg3Dir, "A_FETCH_RSS");
  mkdirSync(pFetchDir, { recursive: true });
  writeFileSync(join(pFetchDir, "action.json"), JSON.stringify({
    name: "A_FETCH_RSS", version: "1.0.0", description: "Fetch",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(pFetchDir, "action.ts"),
    `export default { async execute(input) { return { ...input, fetched: true }; } };`
  );
  const pParseDir = join(pkg3Dir, "A_PARSE_ITEM");
  mkdirSync(pParseDir, { recursive: true });
  writeFileSync(join(pParseDir, "action.json"), JSON.stringify({
    name: "A_PARSE_ITEM", version: "1.0.0", description: "Parse",
    input: {}, output: {}, requires: [],
  }));
  writeFileSync(join(pParseDir, "action.ts"),
    `export default { async execute(input) { return { ...input, parsed: true }; } };`
  );

  db.close();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("discoverArcActions", () => {
  test("finds actions from active packages", async () => {
    const actions = await discoverArcActions(DB_PATH);
    const names = actions.map((a) => a.manifest.name).sort();
    expect(names).toContain("A_FETCH_RSS");
    expect(names).toContain("A_PARSE_ITEM");
  });

  test("skips disabled packages", async () => {
    const actions = await discoverArcActions(DB_PATH);
    const names = actions.map((a) => a.manifest.name);
    expect(names).not.toContain("A_SHOULD_NOT_APPEAR");
  });

  test("includes package source info", async () => {
    const actions = await discoverArcActions(DB_PATH);
    const fetchAction = actions.find((a) => a.manifest.name === "A_FETCH_RSS");
    expect(fetchAction?.packageName).toBe("rss-tools");
    expect(fetchAction?.actionDir).toContain("A_FETCH_RSS");
  });

  test("returns empty for nonexistent database", async () => {
    const actions = await discoverArcActions("/nonexistent/packages.db");
    expect(actions).toEqual([]);
  });
});

describe("discoverArcPipelines", () => {
  test("finds pipeline packages", async () => {
    const pipelines = await discoverArcPipelines(DB_PATH);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].pipeline.name).toBe("P_DIGEST");
    expect(pipelines[0].pipeline.actions).toEqual(["A_FETCH_RSS", "A_PARSE_ITEM"]);
    expect(pipelines[0].packageName).toBe("digest-pipeline");
  });

  test("returns empty for nonexistent database", async () => {
    const pipelines = await discoverArcPipelines("/nonexistent/packages.db");
    expect(pipelines).toEqual([]);
  });
});

describe("createArcActionDirs", () => {
  test("builds actionDirs from active arc packages", async () => {
    const dirs = await createArcActionDirs(DB_PATH);
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    // All dirs should be real directories containing actions
    for (const dir of dirs) {
      expect(dir).toContain("repos");
    }
  });

  test("excludes disabled packages", async () => {
    const dirs = await createArcActionDirs(DB_PATH);
    const hasDisabled = dirs.some((d) => d.includes("disabled-pkg"));
    expect(hasDisabled).toBe(false);
  });
});
