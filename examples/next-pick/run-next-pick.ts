#!/usr/bin/env bun
/**
 * Metafactory Next Pick
 *
 * Scans all repos in the-metafactory org for open work items
 * (issues, PRs, handovers, blueprint features), scores them
 * by label priority + dependency order + type urgency, and
 * uses LLM to select the single most important thing to work on.
 *
 * Usage:
 *   bun examples/next-pick/run-next-pick.ts
 *   bun examples/next-pick/run-next-pick.ts --org the-metafactory
 */

import { runPipelineFromYaml } from "../../src/lib/pipeline";
import { join } from "path";

const PIPELINE_YAML = join(import.meta.dir, "pipeline.yaml");

async function main() {
  const args = process.argv.slice(2);
  const orgIdx = args.indexOf("--org");
  const org = orgIdx >= 0 ? args[orgIdx + 1] : "the-metafactory";

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  Metafactory — What Should I Work On Next?               ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  console.log(`Scanning ${org} repos...\n`);

  const result = await runPipelineFromYaml(
    PIPELINE_YAML,
    { org },
    {}
  );

  // Show step results
  console.log("\nPipeline steps:");
  for (const step of result.steps) {
    const icon = step.success ? "✓" : "✗";
    console.log(`  ${icon} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }
  console.log(`\nTotal: ${result.durationMs}ms | Status: ${result.success ? "completed" : "failed"}\n`);

  if (result.success && result.output?.digest) {
    console.log(result.output.digest);
  } else if (!result.success) {
    console.error("Pipeline failed. Check step errors above.");
    if (result.output?.error) {
      console.error("Error:", result.output.error);
    }
  }
}

main().catch(console.error);
