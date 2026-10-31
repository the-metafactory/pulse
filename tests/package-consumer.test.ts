import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("package consumers use committed declarations under stricter compiler settings and retain runtime assets", async () => {
  const root = resolve(import.meta.dir, "..");
  const dir = await mkdtemp(join(root, ".strict-consumer-"));
  try {
    await mkdir(join(dir, "node_modules"));
    await symlink(root, join(dir, "node_modules", "pulse"), "dir");
    await writeFile(join(dir, "consumer.ts"), `
import { composeFlow, runPipeline, runScenario, type PipelineStep } from "pulse";
const steps: PipelineStep[] = [];
await runPipeline({ name: "packaging-smoke", actions: steps }, {}, { actionDirs: [] });
const llm = async () => ({ text: "Closest I have is none; the gap is a probe action. Pivot to installed actions?" });
await composeFlow("probe", { catalog: [], llm });
await runScenario("probe", {
  blocksDir: ".", llm, poster: { post: async () => "probe" },
  gateProvider: { requestVerdict: async () => ({ verdict: "fail", notes: "not needed" }) },
});
`);
    const compiler = Bun.spawn([join(root, "node_modules", ".bin", "tsc"), "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--skipLibCheck", "--moduleResolution", "bundler", "--module", "preserve", "--target", "ESNext", "consumer.ts"], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
    });
    const diagnostics = await new Response(compiler.stdout).text();
    expect(diagnostics).toBe("");
    expect(await compiler.exited).toBe(0);
    const runtime = Bun.spawn([process.execPath, "consumer.ts"], {
      cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PULSE_PRINCIPAL: "" },
    });
    const errors = await new Response(runtime.stderr).text();
    expect(errors).toBe("");
    expect(await runtime.exited).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
