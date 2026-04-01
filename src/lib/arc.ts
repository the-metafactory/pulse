/**
 * Arc Integration — discover actions and pipelines from arc-installed packages.
 *
 * Pulse reads arc's SQLite database to find installed packages, then
 * scans their repo directories for actions (A_* folders with action.json)
 * and pipelines (pipeline.yaml files).
 *
 * Pulse does NOT import arc's code — it reads the database directly.
 * This keeps the dependency one-way: arc installs, pulse discovers.
 */

import { Database } from "bun:sqlite";
import { readdir } from "fs/promises";
import { join } from "path";
import { loadPipeline, type PipelineDef } from "./pipeline";
import type { ActionManifest } from "../types/action";

// Default arc database path
const DEFAULT_DB_PATH = `${process.env.HOME}/.config/arc/packages.db`;

interface InstalledPackage {
  name: string;
  version: string;
  install_path: string;
  skill_dir: string;
  status: string;
  artifact_type: string;
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
 * Query arc's database for active packages.
 */
function getActivePackages(dbPath: string): InstalledPackage[] {
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT name, version, install_path, skill_dir, status, artifact_type FROM skills WHERE status = 'active'")
      .all() as InstalledPackage[];
    db.close();
    return rows;
  } catch {
    return [];
  }
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
 * Disabled packages are excluded.
 */
export async function discoverArcActions(dbPath: string = DEFAULT_DB_PATH): Promise<ArcAction[]> {
  const packages = getActivePackages(dbPath);
  const allActions: ArcAction[] = [];

  for (const pkg of packages) {
    const actions = await scanForActions(pkg.install_path);
    for (const action of actions) {
      allActions.push({
        ...action,
        packageName: pkg.name,
      });
    }
  }

  return allActions;
}

/**
 * Discover all pipelines from arc-installed pipeline packages.
 *
 * Looks for pipeline.yaml in packages with artifact_type = 'pipeline'.
 */
export async function discoverArcPipelines(dbPath: string = DEFAULT_DB_PATH): Promise<ArcPipeline[]> {
  const packages = getActivePackages(dbPath);
  const pipelines: ArcPipeline[] = [];

  for (const pkg of packages) {
    if (pkg.artifact_type !== "pipeline") continue;

    const yamlPath = join(pkg.install_path, "pipeline.yaml");
    try {
      const { pipeline, baseDir } = await loadPipeline(yamlPath);
      pipelines.push({
        pipeline,
        yamlPath,
        baseDir,
        packageName: pkg.name,
      });
    } catch {
      // No pipeline.yaml or invalid, skip
    }
  }

  return pipelines;
}

/**
 * Build an actionDirs array from all active arc packages.
 *
 * This is the primary integration point: pass the result to
 * runAction(), runPipeline(), or runFlow() as actionDirs.
 *
 * ```typescript
 * const arcDirs = await createArcActionDirs();
 * const result = await runPipeline(pipeline, input, {
 *   actionDirs: ["./local-actions", ...arcDirs],
 * });
 * ```
 */
export async function createArcActionDirs(dbPath: string = DEFAULT_DB_PATH): Promise<string[]> {
  const packages = getActivePackages(dbPath);
  return packages.map((pkg) => pkg.install_path);
}
