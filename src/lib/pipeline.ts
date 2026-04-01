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
