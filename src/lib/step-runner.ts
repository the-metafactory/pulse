/**
 * Step Runner — dispatcher and handlers for iteration/composition primitives.
 *
 * Replaces the linear for-loop in runPipeline with a recursive step dispatcher
 * that handles string (action) steps and object (primitive) steps.
 */

import { runAction } from "./action-runner";
import type { PipelineStep } from "../types/pipeline";
import {
  StepFailure,
  runPrimitiveStep,
  validatePrimitiveStep,
  type StepRecord,
  type StepRunnerOptions,
} from "./primitive-runner";

export {
  StepFailure,
  MapItemFailure,
  type StepRecord,
  type StepRunnerOptions,
} from "./primitive-runner";

// ---------------------------------------------------------------------------
// Step validation — catch malformed YAML at parse time
// ---------------------------------------------------------------------------

/** Validate that a parsed YAML step has a recognized shape. Throws on invalid steps. */
export function validateStep(step: unknown, path: string = "actions"): PipelineStep {
  if (typeof step === "string") return step;

  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`${path}: step must be a string or object, got ${typeof step}`);
  }

  return validatePrimitiveStep(step as Record<string, unknown>, path, validateStep);
}

/** Validate all steps in a pipeline actions array. */
export function validateSteps(steps: unknown[]): PipelineStep[] {
  return steps.map((step, i) => validateStep(step, `actions[${i}]`));
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

export async function runSteps(
  steps: PipelineStep[],
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[] = [],
): Promise<Record<string, unknown>> {
  let current = { ...payload };
  for (const step of steps) {
    if (options.signal?.aborted) {
      throw new Error("Aborted");
    }
    current = await runStep(step, current, options, stepRecords);
  }
  return current;
}

export async function runStep(
  step: PipelineStep,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[] = [],
): Promise<Record<string, unknown>> {
  if (typeof step === "string") {
    return runActionStep(step, payload, options, stepRecords);
  }

  return runPrimitiveStep(step, payload, options, stepRecords, { runSteps });
}

// ---------------------------------------------------------------------------
// String (action) step — existing behavior
// ---------------------------------------------------------------------------

async function runActionStep(
  actionName: string,
  payload: Record<string, unknown>,
  options: StepRunnerOptions,
  stepRecords: StepRecord[],
): Promise<Record<string, unknown>> {
  const stepStart = Date.now();
  options.onActionStepEvent?.({
    type: "step.started",
    action: actionName,
    started_at: new Date(stepStart).toISOString(),
  });
  const result = await runAction(actionName, payload, {
    ...options,
    traceId: crypto.randomUUID(),
  });
  const durationMs = Date.now() - stepStart;

  stepRecords.push({
    action: actionName,
    success: result.success,
    durationMs,
    error: result.error,
  });

  if (!result.success) {
    options.onActionStepEvent?.({
      type: "step.failed",
      action: actionName,
      durationMs,
      error: result.error ?? "unknown error",
    });
    throw new StepFailure(actionName, result.error ?? "unknown error");
  }

  options.onActionStepEvent?.({
    type: "step.completed",
    action: actionName,
    durationMs,
    output_fields:
      result.output && typeof result.output === "object"
        ? Object.keys(result.output as Record<string, unknown>)
        : [],
  });

  if (result.output && typeof result.output === "object") {
    return { ...payload, ...(result.output as Record<string, unknown>) };
  }
  return payload;
}
