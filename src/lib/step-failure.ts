/**
 * Step failure classes, shared by the primitive runner and the primitives
 * that live in their own modules (research). Kept apart so a primitive module
 * can extend StepFailure without a circular import.
 */

export class StepFailure extends Error {
  constructor(
    public readonly step: string,
    public readonly causeError: string,
  ) {
    super(`Step failed: ${step} — ${causeError}`);
    this.name = "StepFailure";
  }
}

export class MapItemFailure extends Error {
  constructor(
    public readonly index: number,
    public readonly item: unknown,
    public readonly causeError: string,
    /** The error the item's sub-pipeline threw, class intact. */
    public readonly original?: unknown,
  ) {
    super(`Map item ${index} failed: ${causeError}`);
    this.name = "MapItemFailure";
  }
}

/**
 * The payload a sub-pipeline held when its failing step started. Each
 * runSteps level records its own payload as the error passes through it,
 * replacing the level nested inside, so whoever called a runSteps reads that
 * level's payload. Kept beside the error, not on it, so a thrown value of any
 * class carries one without being modified.
 */
const partials = new WeakMap<object, Record<string, unknown>>();

export function recordPartialPayload(err: unknown, payload: Record<string, unknown>): void {
  if (err !== null && typeof err === "object") partials.set(err, payload);
}

export function partialPayload(err: unknown): Record<string, unknown> | undefined {
  return err !== null && typeof err === "object" ? partials.get(err) : undefined;
}
