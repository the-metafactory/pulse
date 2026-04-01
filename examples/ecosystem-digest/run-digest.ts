#!/usr/bin/env bun
/**
 * Metafactory Ecosystem Digest
 *
 * Checks all metafactory repos for recent activity, reads blueprint
 * status, summarizes with LLM, and formats for Discord.
 *
 * Usage:
 *   bun examples/ecosystem-digest/run-digest.ts
 *   bun examples/ecosystem-digest/run-digest.ts --days 3
 *   bun examples/ecosystem-digest/run-digest.ts --no-post    # don't post to Discord
 */

import { runPipelineFromYaml } from "../../src/lib/pipeline";
import { join } from "path";

const PIPELINE_YAML = join(import.meta.dir, "pipeline.yaml");

const MF_REPOS = ["arc", "grove", "miner", "pulse", "blueprint", "meta-factory"];

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const sinceDays = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 1;
  const noPost = args.includes("--no-post");

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Metafactory Ecosystem Digest                     ║");
  console.log("║  GitHub → Blueprint → LLM Summary → Discord       ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  console.log(`Checking ${MF_REPOS.length} repos, last ${sinceDays} day(s)\n`);

  const result = await runPipelineFromYaml(
    PIPELINE_YAML,
    {
      org: "the-metafactory",
      repos: MF_REPOS,
      sinceDays,
      skipDiscord: noPost,
    },
    {}
  );

  // Show step results
  console.log("Pipeline steps:");
  for (const step of result.steps) {
    const icon = step.success ? "✓" : "✗";
    console.log(`  ${icon} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }
  console.log(`\nTotal: ${result.durationMs}ms | Status: ${result.success ? "completed" : "failed"}\n`);

  if (result.success && result.output?.digest) {
    console.log("─".repeat(60));
    console.log(result.output.digest);
    console.log("─".repeat(60));

    if (result.output.posted) {
      console.log("\n✓ Posted to Discord #general");
    } else if (noPost) {
      console.log("\n(Discord posting skipped — --no-post)");
    } else {
      console.log("\n⚠ Discord posting failed (non-fatal)");
    }
  }
}

main().catch(console.error);
