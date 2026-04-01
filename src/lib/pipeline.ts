/**
 * Pipeline — linear chain of actions using the pipe model.
 *
 * Data flows forward, context accumulates, nothing is lost.
 * Each action receives all upstream data and adds its own fields.
 *
 * This is the Unix pipe philosophy applied to cloud functions:
 *   Input → Action1 → Action2 → Action3 → Output
 *            {...upstream, ...a1}
 *                       {...upstream, ...a1, ...a2}
 *                                    {...upstream, ...a1, ...a2, ...a3}
 */

import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { runAction, type ActionRunnerOptions } from "./action-runner";
import type { ActionResult } from "../types/action";

export interface PipelineDef {
  /** Pipeline name (e.g. "P_LABEL_EMAIL") */
  name: string;
  /** Ordered list of action names */
  actions: string[];
  /** Optional description */
  description?: string;
}

/**
 * Load a pipeline definition from a pipeline.yaml file.
 *
 * The YAML file format:
 *   name: P_RSS_DIGEST
 *   description: "Fetch → Extract → Rate → Recommend"
 *   actions:
 *     - A_FETCH_FEED
 *     - A_EXTRACT_ARTICLE
 *     - A_RATE
 *     - A_RECOMMEND
 *
 * Actions are resolved from:
 *   1. The directory containing the pipeline.yaml (bundled actions)
 *   2. Any additional actionDirs passed to runPipeline
 */
export async function loadPipeline(yamlPath: string): Promise<{
  pipeline: PipelineDef;
  /** Directory containing the pipeline.yaml — used as an action source */
  baseDir: string;
}> {
  const file = Bun.file(yamlPath);
  if (!(await file.exists())) {
    throw new Error(`Pipeline file not found: ${yamlPath}`);
  }

  const content = await file.text();
  const parsed = parseSimpleYaml(content);

  if (!parsed.name || typeof parsed.name !== "string") {
    throw new Error(`Pipeline YAML missing required 'name' field: ${yamlPath}`);
  }
  if (!parsed.actions || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    throw new Error(`Pipeline YAML missing or empty 'actions' list: ${yamlPath}`);
  }

  return {
    pipeline: {
      name: parsed.name,
      actions: parsed.actions,
      description: parsed.description,
    },
    baseDir: dirname(yamlPath),
  };
}

/**
 * Load and execute a pipeline from a YAML file.
 *
 * Convenience wrapper: loads the pipeline definition, prepends its
 * directory to actionDirs, and runs it.
 */
export async function runPipelineFromYaml(
  yamlPath: string,
  initialInput: Record<string, unknown>,
  options: Omit<ActionRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
    mode?: "local" | "cloud";
  }
): Promise<PipelineResult> {
  const { pipeline, baseDir } = await loadPipeline(yamlPath);

  // Pipeline's own directory is the first place to look for actions
  const actionDirs = [baseDir, ...(options.actionDirs || [])];

  return runPipeline(pipeline, initialInput, { ...options, actionDirs });
}

/**
 * Scan a directory for pipeline.yaml files.
 * Returns all discovered pipeline definitions.
 */
export async function discoverPipelines(dir: string): Promise<Array<{
  pipeline: PipelineDef;
  yamlPath: string;
  baseDir: string;
}>> {
  const results: Array<{ pipeline: PipelineDef; yamlPath: string; baseDir: string }> = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const yamlPath = join(dir, entry.name, "pipeline.yaml");
        try {
          const { pipeline, baseDir } = await loadPipeline(yamlPath);
          results.push({ pipeline, yamlPath, baseDir });
        } catch {
          // Not a pipeline directory, skip
        }
      }
    }
  } catch {
    // Directory doesn't exist, return empty
  }

  return results;
}

/**
 * Minimal YAML parser for pipeline definitions.
 * Handles the simple flat structure we need without pulling in a YAML library.
 */
function parseSimpleYaml(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentList: string[] | null = null;
  let currentKey: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();

    // Skip comments and empty lines
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // List item: "  - value"
    if (line.match(/^\s+-\s+/) && currentKey && currentList) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      currentList.push(value);
      continue;
    }

    // Key-value: "key: value" or "key:"
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim().replace(/^["']|["']$/g, "");

      if (value === "" || value === "[]") {
        // Start of a list or empty value
        currentKey = key;
        currentList = [];
        result[key] = currentList;
      } else {
        currentKey = null;
        currentList = null;
        result[key] = value;
      }
    }
  }

  return result;
}

export interface PipelineResult {
  success: boolean;
  /** Final accumulated output (all action fields merged) */
  output?: Record<string, unknown>;
  /** Per-action results for debugging */
  steps: Array<{
    action: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }>;
  /** Total execution time */
  durationMs: number;
}

/**
 * Execute a pipeline: run actions in sequence with the passthrough pattern.
 *
 * Each action's output becomes the next action's input.
 * Data accumulates — the final action has access to every field from every
 * preceding action, not just the immediately previous one.
 */
export async function runPipeline(
  pipeline: PipelineDef,
  initialInput: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" }
): Promise<PipelineResult> {
  const startTime = Date.now();
  const steps: PipelineResult["steps"] = [];
  let currentData = { ...initialInput };

  for (let i = 0; i < pipeline.actions.length; i++) {
    const actionName = pipeline.actions[i];
    const stepStart = Date.now();

    const result: ActionResult = await runAction(actionName, currentData, {
      ...options,
      traceId: crypto.randomUUID(),
    });

    const stepDuration = Date.now() - stepStart;

    steps.push({
      action: actionName,
      success: result.success,
      durationMs: stepDuration,
      error: result.error,
    });

    if (!result.success) {
      return {
        success: false,
        output: currentData,
        steps,
        durationMs: Date.now() - startTime,
      };
    }

    // Pipe model: merge action output into accumulated data
    if (result.output && typeof result.output === "object") {
      currentData = { ...currentData, ...(result.output as Record<string, unknown>) };
    }
  }

  return {
    success: true,
    output: currentData,
    steps,
    durationMs: Date.now() - startTime,
  };
}
