#!/usr/bin/env bun
/**
 * Metafactory Repo Sync
 *
 * Discovers all repos in the-metafactory org, pulls latest changes
 * for repos that exist locally, clones any new repos.
 *
 * Usage:
 *   bun examples/sync-repos/run-sync-repos.ts
 *   bun examples/sync-repos/run-sync-repos.ts --org the-metafactory
 *   bun examples/sync-repos/run-sync-repos.ts --dir ~/work/mf
 */

import { runPipelineFromYaml } from "../../src/lib/pipeline";
import { join } from "path";

const PIPELINE_YAML = join(import.meta.dir, "pipeline.yaml");

async function main() {
  const args = process.argv.slice(2);
  const orgIdx = args.indexOf("--org");
  const org = orgIdx >= 0 ? args[orgIdx + 1] : "the-metafactory";
  const dirIdx = args.indexOf("--dir");
  const workDir = dirIdx >= 0 ? args[dirIdx + 1] : `${process.env.HOME}/work/mf`;

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  metafactory — Syncing All Repos                         ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  console.log(`Discovering ${org} repos → ${workDir}\n`);

  const result = await runPipelineFromYaml(
    PIPELINE_YAML,
    { org, workDir },
    {}
  );

  for (const step of result.steps) {
    const icon = step.success ? "✓" : "✗";
    console.log(`  ${icon} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }
  console.log(`\nTotal: ${result.durationMs}ms | Status: ${result.success ? "completed" : "failed"}\n`);

  if (result.success && result.output?.digest) {
    console.log(result.output.digest);
  } else if (!result.success) {
    console.error("Pipeline failed. Check step errors above.");
  }
}

main().catch(console.error);
