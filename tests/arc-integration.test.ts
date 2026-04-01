import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  discoverArcActions,
  discoverArcPipelines,
  createArcActionDirs,
} from "../src/lib/arc";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-arc-repos");

beforeAll(() => {
  // Package 1: a tool with actions
  const pkg1Dir = join(TEST_DIR, "rss-tools");
  mkdirSync(pkg1Dir, { recursive: true });
  writeFileSync(
    join(pkg1Dir, "arc-manifest.yaml"),
    "name: rss-tools\nversion: 1.0.0\ntype: tool\n"
  );

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

  // Package 2: a skill with no actions (should be discovered but have 0 actions)
  const pkg2Dir = join(TEST_DIR, "empty-skill");
  mkdirSync(pkg2Dir, { recursive: true });
  writeFileSync(
    join(pkg2Dir, "arc-manifest.yaml"),
    "name: empty-skill\nversion: 1.0.0\ntype: skill\n"
  );

  // Package 3: a pipeline
  const pkg3Dir = join(TEST_DIR, "digest-pipeline");
  mkdirSync(pkg3Dir, { recursive: true });
  writeFileSync(
    join(pkg3Dir, "arc-manifest.yaml"),
    "name: digest-pipeline\nversion: 1.0.0\ntype: pipeline\n"
  );
  writeFileSync(join(pkg3Dir, "pipeline.yaml"),
    "name: P_DIGEST\ndescription: A digest pipeline\nactions:\n  - A_FETCH_RSS\n  - A_PARSE_ITEM\n"
  );
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
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("discoverArcActions", () => {
  test("finds actions from packages", async () => {
    const actions = await discoverArcActions(TEST_DIR);
    const names = actions.map((a) => a.manifest.name).sort();
    expect(names).toContain("A_FETCH_RSS");
    expect(names).toContain("A_PARSE_ITEM");
  });

  test("includes package source info", async () => {
    const actions = await discoverArcActions(TEST_DIR);
    const fetchAction = actions.find(
      (a) => a.manifest.name === "A_FETCH_RSS" && a.packageName === "rss-tools"
    );
    expect(fetchAction).toBeDefined();
    expect(fetchAction!.actionDir).toContain("A_FETCH_RSS");
  });

  test("returns empty for nonexistent directory", async () => {
    const actions = await discoverArcActions("/nonexistent/repos");
    expect(actions).toEqual([]);
  });
});

describe("discoverArcPipelines", () => {
  test("finds pipeline packages", async () => {
    const pipelines = await discoverArcPipelines(TEST_DIR);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].pipeline.name).toBe("P_DIGEST");
    expect(pipelines[0].pipeline.actions).toEqual(["A_FETCH_RSS", "A_PARSE_ITEM"]);
    expect(pipelines[0].packageName).toBe("digest-pipeline");
  });

  test("returns empty for nonexistent directory", async () => {
    const pipelines = await discoverArcPipelines("/nonexistent/repos");
    expect(pipelines).toEqual([]);
  });
});

describe("createArcActionDirs", () => {
  test("builds actionDirs from arc packages", async () => {
    const dirs = await createArcActionDirs(TEST_DIR);
    expect(dirs.length).toBe(3); // rss-tools, empty-skill, digest-pipeline
    expect(dirs.some((d) => d.includes("rss-tools"))).toBe(true);
  });
});
