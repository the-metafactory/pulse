/**
 * Pipeline — linear chain of actions using the pipe model.
 *
 * Data flows forward, context accumulates, nothing is lost.
 * Each action receives all payload data and adds its own fields.
 *
 * This is the Unix pipe philosophy applied to cloud functions:
 *   Input → Action1 → Action2 → Action3 → Output
 *            {...payload, ...a1}
 *                       {...payload, ...a1, ...a2}
 *                                    {...payload, ...a1, ...a2, ...a3}
 *
 * Steps can be action names (strings) or composition primitives:
 *   map, filter, reduce, parallel, retry.
 */

import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { preflightSteps, runStep, validateSteps, type StepRecord, type StepRunnerOptions } from "./step-runner";
import type { PipelineStep } from "../types/pipeline";

export interface PipelineDef {
  /** Pipeline name (e.g. "P_LABEL_EMAIL") */
  name: string;
  /** Ordered list of pipeline steps (action names or composition primitives) */
  actions: PipelineStep[];
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
  const parsed = parseYaml(content) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Pipeline YAML is not a valid document: ${yamlPath}`);
  }
  if (!parsed.name || typeof parsed.name !== "string") {
    throw new Error(`Pipeline YAML missing required 'name' field: ${yamlPath}`);
  }
  if (!parsed.actions || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    throw new Error(`Pipeline YAML missing or empty 'actions' list: ${yamlPath}`);
  }

  // Validate step shapes at parse time (catches typos like { mapp: ... } early)
  const validatedActions = validateSteps(parsed.actions);

  return {
    pipeline: {
      name: parsed.name as string,
      actions: validatedActions,
      description: parsed.description as string | undefined,
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
  options: Omit<StepRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
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
        } catch (_err) {
          // Not a pipeline directory — no pipeline.yaml or invalid format
        }
      }
    }
  } catch (_err) {
    // Directory doesn't exist or isn't readable, return empty
  }

  return results;
}

export interface PipelineResult {
  success: boolean;
  /** Final accumulated output (all action fields merged) */
  output?: Record<string, unknown>;
  /** Error message if the pipeline failed */
  error?: string;
  /**
   * The error the failing step threw, class intact — e.g. a host checks
   * `cause instanceof ResearchUnavailable` to queue the run for later.
   */
  cause?: unknown;
  /** Per-step results for debugging */
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
 * Execute a pipeline: run steps in sequence with the passthrough pattern.
 *
 * Steps can be action names (strings) or composition primitives (map, filter,
 * reduce, parallel, retry). Data accumulates through the pipeline — the final
 * step has access to every field from every preceding step.
 */
export async function runPipeline(
  pipeline: PipelineDef,
  initialInput: Record<string, unknown>,
  options: StepRunnerOptions
): Promise<PipelineResult> {
  const startTime = Date.now();
  const stepRecords: StepRecord[] = [];

  // Run steps one-by-one to preserve partial output on failure
  let currentData = { ...initialInput };
  try {
    // A research step that would offer a model anything but a read action
    // fails the pipeline here, before any step runs. The returned options
    // carry this run's state (what the preflight checked).
    const runOptions = await preflightSteps(pipeline.actions, options);
    for (const step of pipeline.actions) {
      currentData = await runStep(step, currentData, runOptions, stepRecords);
    }
    return {
      success: true,
      output: currentData,
      steps: stepRecords,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      output: currentData,
      error: err instanceof Error ? err.message : String(err),
      cause: err,
      steps: stepRecords,
      durationMs: Date.now() - startTime,
    };
  }
}
