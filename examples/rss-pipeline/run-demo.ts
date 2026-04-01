#!/usr/bin/env bun
/**
 * Pulse RSS Pipeline Demo
 *
 * Demonstrates the full pipeline from Daniel Miessler's Arbol vision:
 *   A_FETCH_FEED → A_EXTRACT_ARTICLE → A_RATE → A_RECOMMEND
 *
 * This is the same pattern as PAI's RSS intelligence flow, adapted as
 * a pulse pipeline with the passthrough pipe model.
 *
 * Usage:
 *   bun examples/rss-pipeline/run-demo.ts [feed-url]
 *
 * Default feed: Simon Willison's blog (high-quality AI/tech content)
 */

import { runPipeline } from "../../src/lib/pipeline";
import { join } from "path";

const ACTIONS_DIR = join(import.meta.dir);
const DEFAULT_FEED = "https://simonwillison.net/atom/everything/";

async function main() {
  const feedUrl = process.argv[2] || DEFAULT_FEED;

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Pulse RSS Pipeline Demo                     ║");
  console.log("║  A_FETCH_FEED → A_EXTRACT → A_RATE → A_REC  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  console.log(`Feed: ${feedUrl}\n`);

  const result = await runPipeline(
    {
      name: "P_RSS_DIGEST",
      actions: ["A_FETCH_FEED", "A_EXTRACT_ARTICLE", "A_RATE", "A_RECOMMEND"],
    },
    { feedUrl, limit: 3 },
    { actionDirs: [ACTIONS_DIR] }
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
  }
}

main().catch(console.error);
