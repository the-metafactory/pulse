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
