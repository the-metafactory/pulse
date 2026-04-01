/**
 * Arc Integration — discover actions and pipelines from arc-installed packages.
 *
 * Pulse calls arc's CLI (`arc list --json`) to discover installed packages,
 * then scans their repo directories for actions and pipelines.
 *
 * Pulse does NOT read arc's database directly. Arc owns its storage format;
 * pulse consumes the public CLI contract. See: the-metafactory/arc#20.
 *
 * Until arc#20 lands (--json flag), this module falls back to scanning
 * the known repos directory (~/.config/arc/pkg/repos/) directly.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { loadPipeline, type PipelineDef } from "./pipeline";
import type { ActionManifest } from "../types/action";

const DEFAULT_REPOS_DIR = `${process.env.HOME}/.config/arc/pkg/repos`;

interface ArcPackage {
  name: string;
  version: string;
  type: string;
  status: string;
  installPath: string;
}

export interface ArcAction {
  /** The action manifest (from action.json) */
  manifest: ActionManifest;
  /** Full path to the action directory */
  actionDir: string;
  /** Name of the arc package that provides this action */
  packageName: string;
}

export interface ArcPipeline {
  /** The pipeline definition (from pipeline.yaml) */
  pipeline: PipelineDef;
  /** Full path to the pipeline.yaml */
  yamlPath: string;
  /** Directory containing the pipeline */
  baseDir: string;
  /** Name of the arc package */
  packageName: string;
}

/**
 * Query arc for installed packages via CLI.
 *
 * Tries `arc list --json` first. Falls back to scanning the repos directory.
 */
async function getInstalledPackages(reposDir: string = DEFAULT_REPOS_DIR): Promise<ArcPackage[]> {
  // Try arc CLI first (arc#20)
  try {
    const proc = Bun.spawn(["arc", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && stdout.trim()) {
      const data = JSON.parse(stdout);
      if (Array.isArray(data.packages)) {
        return data.packages;
      }
    }
  } catch {
    // arc CLI not available or doesn't support --json yet
  }

  // Fallback: scan repos directory
  return scanReposDirectory(reposDir);
}

/**
 * Fallback: scan the repos directory for packages.
 * Each subdirectory is assumed to be an installed package.
 */
async function scanReposDirectory(reposDir: string): Promise<ArcPackage[]> {
  const packages: ArcPackage[] = [];

  try {
    const entries = await readdir(reposDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pkgDir = join(reposDir, entry.name);

      // Try to read arc-manifest.yaml or pai-manifest.yaml for metadata
      let type = "unknown";
      let version = "0.0.0";
      for (const manifestName of ["arc-manifest.yaml", "pai-manifest.yaml"]) {
        const manifestFile = Bun.file(join(pkgDir, manifestName));
        try {
          if (await manifestFile.exists()) {
            const content = await manifestFile.text();
            const typeMatch = content.match(/^type:\s*(.+)/m);
            const versionMatch = content.match(/^version:\s*(.+)/m);
            if (typeMatch) type = typeMatch[1].trim();
            if (versionMatch) version = versionMatch[1].trim();
            break;
          }
        } catch {
          continue;
        }
      }

      packages.push({
        name: entry.name,
        version,
        type,
        status: "active",
        installPath: pkgDir,
      });
    }
  } catch {
    // Directory doesn't exist
  }

  return packages;
}

/**
 * Scan a directory for A_* action subdirectories.
 */
async function scanForActions(dir: string): Promise<Array<{ manifest: ActionManifest; actionDir: string }>> {
  const actions: Array<{ manifest: ActionManifest; actionDir: string }> = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("A_")) continue;

      const actionDir = join(dir, entry.name);
      const manifestFile = Bun.file(join(actionDir, "action.json"));

      try {
        if (await manifestFile.exists()) {
          const manifest = await manifestFile.json() as ActionManifest;
          actions.push({ manifest, actionDir });
        }
      } catch {
        // Invalid action.json, skip
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return actions;
}

/**
 * Discover all actions from arc-installed packages.
 *
 * Scans active packages for A_* directories containing action.json.
 */
export async function discoverArcActions(reposDir: string = DEFAULT_REPOS_DIR): Promise<ArcAction[]> {
  const packages = await getInstalledPackages(reposDir);
  const allActions: ArcAction[] = [];

  for (const pkg of packages) {
    if (pkg.status === "disabled") continue;
    const actions = await scanForActions(pkg.installPath);
    for (const action of actions) {
      allActions.push({ ...action, packageName: pkg.name });
    }
  }

  return allActions;
}

/**
 * Discover all pipelines from arc-installed pipeline packages.
 */
export async function discoverArcPipelines(reposDir: string = DEFAULT_REPOS_DIR): Promise<ArcPipeline[]> {
  const packages = await getInstalledPackages(reposDir);
  const pipelines: ArcPipeline[] = [];

  for (const pkg of packages) {
    if (pkg.status === "disabled") continue;
    if (pkg.type !== "pipeline") continue;

    const yamlPath = join(pkg.installPath, "pipeline.yaml");
    try {
      const { pipeline, baseDir } = await loadPipeline(yamlPath);
      pipelines.push({ pipeline, yamlPath, baseDir, packageName: pkg.name });
    } catch {
      // No pipeline.yaml or invalid, skip
    }
  }

  return pipelines;
}

/**
 * Build an actionDirs array from all active arc packages.
 *
 * Pass the result to runAction(), runPipeline(), or runFlow():
 *
 * ```typescript
 * const arcDirs = await createArcActionDirs();
 * const result = await runPipeline(pipeline, input, {
 *   actionDirs: ["./local-actions", ...arcDirs],
 * });
 * ```
 */
export async function createArcActionDirs(reposDir: string = DEFAULT_REPOS_DIR): Promise<string[]> {
  const packages = await getInstalledPackages(reposDir);
  return packages
    .filter((pkg) => pkg.status !== "disabled")
    .map((pkg) => pkg.installPath);
}
