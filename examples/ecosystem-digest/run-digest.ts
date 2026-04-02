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
import { homedir } from "os";
import YAML from "yaml";

const PIPELINE_YAML = join(import.meta.dir, "pipeline.yaml");
const DEFAULT_ORG = "the-metafactory";

/**
 * Resolve repos from compass ecosystem/repos.yaml (canonical source of truth).
 * Fallback chain: compass → gh repo list → PULSE_REPOS env var.
 * Only returns "active" repos by default.
 */
async function resolveRepos(org: string): Promise<string[]> {
  // 1. Try compass ecosystem/repos.yaml
  const compassRepos = await readCompassRepos();
  if (compassRepos.length > 0) return compassRepos;

  // 2. Fallback: gh repo list (for setups without local compass checkout)
  const dynamic = await fetchOrgRepos(org);
  if (dynamic.length > 0) return dynamic;

  // 3. Env var override (for non-org-member setups)
  if (process.env.PULSE_REPOS) {
    return process.env.PULSE_REPOS.split(",").map(r => r.trim()).filter(Boolean);
  }

  throw new Error(
    `Could not list repos. Either:\n` +
    `  - Check out compass at ~/Developer/compass\n` +
    `  - Authenticate with gh: gh auth login\n` +
    `  - Set PULSE_REPOS env var: PULSE_REPOS=arc,grove,pulse`
  );
}

/** Read active repos from compass/ecosystem/repos.yaml */
async function readCompassRepos(): Promise<string[]> {
  const devRoot = process.env.PULSE_DEV_ROOT || join(homedir(), "Developer");
  const compassPath = process.env.COMPASS_PATH || join(devRoot, "compass");
  const reposPath = join(compassPath, "ecosystem", "repos.yaml");

  try {
    const file = Bun.file(reposPath);
    if (!(await file.exists())) return [];
    const parsed = YAML.parse(await file.text()) as { repos?: Record<string, { status?: string }> };
    if (!parsed?.repos) return [];
    return Object.entries(parsed.repos)
      .filter(([_, entry]) => entry.status === "active")
      .map(([name]) => name)
      .sort();
  } catch (_err) {
    // Compass not available — fall through
    return [];
  }
}

/** Fetch all repos in the org dynamically via gh CLI */
async function fetchOrgRepos(org: string): Promise<string[]> {
  const proc = Bun.spawnSync(
    ["gh", "repo", "list", org, "--json", "name", "--jq", ".[].name", "--limit", "100"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    if (stderr) process.stderr.write(`gh repo list failed: ${stderr}\n`);
    return [];
  }
  return proc.stdout.toString().trim().split("\n").filter(Boolean).sort();
}

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const sinceDays = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 1;
  const noPost = args.includes("--no-post");
  const orgIdx = args.indexOf("--org");
  const org = orgIdx >= 0 ? args[orgIdx + 1] : DEFAULT_ORG;

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Metafactory Ecosystem Digest                     ║");
  console.log("║  GitHub → Blueprint → LLM Summary → Discord       ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  const repos = await resolveRepos(org);
  console.log(`Checking ${repos.length} repos in ${org}, last ${sinceDays} day(s)\n`);

  const result = await runPipelineFromYaml(
    PIPELINE_YAML,
    {
      org,
      repos,
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
