import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { discoverArcFlows } from "../src/lib/arc";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-flow-cli");

beforeAll(() => {
  // Package 1: has a flow with inline pipeline
  const pkg1Dir = join(TEST_DIR, "test-flow-pkg");
  mkdirSync(pkg1Dir, { recursive: true });
  writeFileSync(
    join(pkg1Dir, "arc-manifest.yaml"),
    "name: test-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );
  writeFileSync(
    join(pkg1Dir, "flow.yaml"),
    [
      "name: F_TEST_FLOW",
      'description: "A test flow for CLI testing"',
      "source:",
      "  type: inline",
      "destination:",
      "  type: stdout",
      "pipeline: ./pipeline.yaml",
    ].join("\n")
  );
  writeFileSync(
    join(pkg1Dir, "pipeline.yaml"),
    "name: P_TEST\ndescription: Test pipeline\nactions:\n  - A_DOUBLE\n"
  );

  // A_DOUBLE action inside the package
  const doubleDir = join(pkg1Dir, "A_DOUBLE");
  mkdirSync(doubleDir, { recursive: true });
  writeFileSync(
    join(doubleDir, "action.json"),
    JSON.stringify({
      name: "A_DOUBLE",
      version: "1.0.0",
      description: "Double a value",
      input: { value: { type: "number", required: true } },
      output: { doubled: { type: "number" } },
      requires: [],
    })
  );
  writeFileSync(
    join(doubleDir, "action.ts"),
    `export default {
      async execute(input) {
        const { value, ...payload } = input;
        return { ...payload, value, doubled: Number(value) * 2 };
      }
    };`
  );

  // Package 2: no flow.yaml
  const pkg2Dir = join(TEST_DIR, "no-flow-pkg");
  mkdirSync(pkg2Dir, { recursive: true });
  writeFileSync(
    join(pkg2Dir, "arc-manifest.yaml"),
    "name: no-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );

  // Package 3: second flow
  const pkg3Dir = join(TEST_DIR, "second-flow-pkg");
  mkdirSync(pkg3Dir, { recursive: true });
  writeFileSync(
    join(pkg3Dir, "arc-manifest.yaml"),
    "name: second-flow-pkg\nversion: 1.0.0\ntype: tool\n"
  );
  writeFileSync(
    join(pkg3Dir, "flow.yaml"),
    [
      "name: F_SECOND",
      "source:",
      "  type: inline",
      "destination:",
      "  type: stdout",
      "pipeline: ./pipeline.yaml",
    ].join("\n")
  );
  writeFileSync(
    join(pkg3Dir, "pipeline.yaml"),
    "name: P_SECOND\nactions:\n  - A_DOUBLE\n"
  );
  const doubleDir2 = join(pkg3Dir, "A_DOUBLE");
  mkdirSync(doubleDir2, { recursive: true });
  writeFileSync(
    join(doubleDir2, "action.json"),
    JSON.stringify({
      name: "A_DOUBLE",
      version: "1.0.0",
      description: "Double",
      input: {},
      output: {},
      requires: [],
    })
  );
  writeFileSync(
    join(doubleDir2, "action.ts"),
    `export default { async execute(input) { return { ...input, doubled: (input.value || 0) * 2 }; } };`
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("discoverArcFlows", () => {
  test("finds flows from packages with flow.yaml", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const names = flows.map((f) => f.flow.name).sort();
    expect(names).toContain("F_TEST_FLOW");
    expect(names).toContain("F_SECOND");
  });

  test("skips packages without flow.yaml", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const pkgNames = flows.map((f) => f.packageName);
    expect(pkgNames).not.toContain("no-flow-pkg");
  });

  test("includes metadata", async () => {
    const flows = await discoverArcFlows(TEST_DIR);
    const testFlow = flows.find((f) => f.flow.name === "F_TEST_FLOW");
    expect(testFlow).toBeDefined();
    expect(testFlow!.packageName).toBe("test-flow-pkg");
    expect(testFlow!.yamlPath).toContain("flow.yaml");
    expect(testFlow!.baseDir).toContain("test-flow-pkg");
    expect(testFlow!.flow.description).toBe("A test flow for CLI testing");
  });

  test("returns empty for nonexistent directory", async () => {
    const flows = await discoverArcFlows("/nonexistent/repos");
    expect(flows).toEqual([]);
  });
});

describe("pulse flow CLI", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  test("pulse flow list runs without crashing", async () => {
    const proc = Bun.spawn(
      ["bun", cli, "flow", "list"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    // Smoke test: CLI is wired correctly and doesn't crash.
    // Actual flow discovery is tested by discoverArcFlows unit tests above.
    expect(proc.exitCode).toBe(0);
  });

  test("pulse flow run with nonexistent flow exits with error", async () => {
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", "F_NONEXISTENT"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("pulse flow run with yaml path and --dry-run validates", async () => {
    const flowYaml = join(TEST_DIR, "test-flow-pkg", "flow.yaml");
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", flowYaml, "--dry-run"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain("F_TEST_FLOW");
    expect(stdout).toContain("valid");
  });

  test("pulse flow run executes a flow from yaml path with passthrough args", async () => {
    const flowYaml = join(TEST_DIR, "test-flow-pkg", "flow.yaml");
    const proc = Bun.spawn(
      ["bun", cli, "flow", "run", flowYaml, "--value", "21"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stderr).toContain("completed");
    // stdout should contain the pipeline output (destination: stdout)
    expect(stdout).toContain("doubled");
  });
});

describe("pulse flow save, show and list --saved", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const root = join(TEST_DIR, "saved-cli");
  const flowsDir = join(root, "flows");
  const flowFile = join(root, "F_CLI_SAVED.yaml");

  async function pulse(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", cli, "flow", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  }

  beforeAll(() => {
    mkdirSync(root, { recursive: true });
    writeFileSync(flowFile, "name: F_CLI_SAVED\nactions:\n  - A_DOUBLE # sovereignty: D, residency: CH\n");
  }, 20_000);

  test("save reports saved, then exists; show answers by name and request ID", async () => {
    const saved = await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0001", "--conversation", "probe", "--flows-dir", flowsDir, "--json"]);
    expect(saved.code).toBe(0);
    const first = JSON.parse(saved.stdout);
    expect(first).toMatchObject({ status: "saved", name: "F_CLI_SAVED", path: join(flowsDir, "F_CLI_SAVED.yaml") });

    const again = await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0001", "--conversation", "probe", "--flows-dir", flowsDir, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ ...first, status: "exists" });

    const byName = await pulse(["show", "F_CLI_SAVED", "--flows-dir", flowsDir, "--json"]);
    expect(byName.code).toBe(0);
    const shown = JSON.parse(byName.stdout);
    expect(Object.keys(shown).sort()).toEqual(["name", "path", "provenance", "sha256", "source", "yaml"]);
    expect(shown).toMatchObject({ source: "saved", sha256: first.sha256, provenance: { origin: "conversation", conversation: "probe", request_id: "cli-probe-0001" } });

    const byRequest = await pulse(["show", "--request-id", "cli-probe-0001", "--flows-dir", flowsDir, "--json"]);
    expect(byRequest.code).toBe(0);
    expect(JSON.parse(byRequest.stdout).sha256).toBe(first.sha256);
  }, 20_000);

  test("conflict and invalid exit 1 with their JSON shape", async () => {
    const conflict = await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0002", "--flows-dir", flowsDir, "--json"]);
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout)).toEqual({ status: "conflict", reason: "A saved flow is already named F_CLI_SAVED." });

    const badFile = join(root, "bad.yaml");
    writeFileSync(badFile, "name: f_lower\nactions:\n  - A_DOUBLE\n");
    const invalid = await pulse(["save", "--file", badFile, "--request-id", "cli-probe-0003", "--flows-dir", flowsDir, "--json"]);
    expect(invalid.code).toBe(1);
    const body = JSON.parse(invalid.stdout);
    expect(body.status).toBe("invalid");
    expect(body.findings[0].rule).toBe("name");
  }, 20_000);

  test("show exits 1 with not-found, and 2 with unreadable for an unreadable directory", async () => {
    const missing = await pulse(["show", "--request-id", "cli-missing-01", "--flows-dir", join(root, "absent"), "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ status: "not-found" });

    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const unreadable = await pulse(["show", "F_CLI_SAVED", "--flows-dir", locked, "--json"]);
      expect(unreadable.code).toBe(2);
      expect(JSON.parse(unreadable.stdout).status).toBe("unreadable");
    } finally {
      chmodSync(locked, 0o700);
    }
  }, 20_000);

  test("list --saved marks the saved flow; plain list ignores saved flows", async () => {
    const xdg = join(root, "xdg");
    const saved = await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0004"], { XDG_CONFIG_HOME: xdg });
    expect(JSON.parse(saved.stdout)).toMatchObject({ status: "saved", path: join(xdg, "pulse", "flows", "F_CLI_SAVED.yaml") });

    const listed = await pulse(["list", "--saved", "--json"], { XDG_CONFIG_HOME: xdg });
    expect(listed.code).toBe(0);
    const shown = JSON.parse((await pulse(["show", "F_CLI_SAVED", "--json"], { XDG_CONFIG_HOME: xdg })).stdout);
    expect(JSON.parse(listed.stdout).flows).toContainEqual({
      name: "F_CLI_SAVED",
      source: "saved",
      path: join(xdg, "pulse", "flows", "F_CLI_SAVED.yaml"),
      package: null,
      sha256: shown.sha256,
      provenance: shown.provenance,
    });

    const human = await pulse(["list", "--saved"], { XDG_CONFIG_HOME: xdg });
    expect(human.stdout).toContain("F_CLI_SAVED  [saved]");

    const plain = await pulse(["list"], { XDG_CONFIG_HOME: xdg });
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("F_CLI_SAVED");
    expect(plain.stdout).not.toContain("[saved]");
  }, 20_000);

  test("delete answers deleted, then absent, with exit 0; a wrong hash is a conflict with exit 1", async () => {
    const dir = join(root, "delete-flows");
    const saved = JSON.parse((await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0005", "--flows-dir", dir, "--json"])).stdout);
    const deleted = await pulse(["delete", "F_CLI_SAVED", "--expected-sha256", saved.sha256, "--flows-dir", dir, "--json"]);
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({ status: "deleted", name: "F_CLI_SAVED", sha256: saved.sha256 });

    const again = await pulse(["delete", "F_CLI_SAVED", "--expected-sha256", saved.sha256, "--flows-dir", dir, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ status: "absent", name: "F_CLI_SAVED" });

    await pulse(["save", "--file", flowFile, "--request-id", "cli-probe-0006", "--flows-dir", dir, "--json"]);
    const conflict = await pulse(["delete", "F_CLI_SAVED", "--expected-sha256", "0".repeat(64), "--flows-dir", dir, "--json"]);
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout).status).toBe("conflict");
    expect(existsSync(join(dir, "F_CLI_SAVED.yaml"))).toBe(true);
  }, 20_000);

  test("delete without --expected-sha256 is invalid with exit 1; an unreadable directory exits 2", async () => {
    const invalid = await pulse(["delete", "F_CLI_SAVED", "--flows-dir", flowsDir, "--json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: "invalid", findings: [{ rule: "expected-sha256" }] });

    const locked = join(root, "delete-locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const unreadable = await pulse(["delete", "F_CLI_SAVED", "--expected-sha256", "a".repeat(64), "--flows-dir", locked, "--json"]);
      expect(unreadable.code).toBe(2);
      expect(JSON.parse(unreadable.stdout).status).toBe("unreadable");
    } finally {
      chmodSync(locked, 0o700);
    }
  }, 20_000);
});
