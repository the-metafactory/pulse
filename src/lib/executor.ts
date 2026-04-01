import type { PulseNode, PulseResult, ExecutionContext } from "../types/pulse";

const DEFAULT_RETRIES = 2;

/**
 * Execute a node function with timeout via Promise.race.
 */
async function executeWithTimeout(
  fn: (context: ExecutionContext) => Promise<any>,
  context: ExecutionContext,
  timeoutMs?: number
): Promise<any> {
  if (!timeoutMs) return fn(context);

  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      fn(context),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export class Executor {
  /**
   * Execute a node with retry logic.
   * Returns a PulseResult with final status.
   */
  async execute(
    node: PulseNode,
    context: ExecutionContext,
    onAttempt?: (attempt: number, willRetry: boolean, error?: Error) => void
  ): Promise<PulseResult> {
    const maxRetries = node.retries ?? DEFAULT_RETRIES;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const startedAt = new Date();
      try {
        const result = await executeWithTimeout(
          node.fn,
          context,
          node.timeout
        );
        return {
          nodeId: node.id,
          status: "done",
          result,
          startedAt,
          completedAt: new Date(),
          attempts: attempt,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const willRetry = attempt <= maxRetries;
        onAttempt?.(attempt, willRetry, lastError);
        if (!willRetry) break;
      }
    }

    return {
      nodeId: node.id,
      status: "failed",
      error: lastError,
      startedAt: new Date(),
      completedAt: new Date(),
      attempts: maxRetries + 1,
    };
  }
}
