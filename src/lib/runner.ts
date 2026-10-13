import { withRunLedger } from "./run-ledger";
import { EventEmitter } from "events";
import { TreeParser } from "./parser";
import { Scheduler } from "./scheduler";
import { Executor } from "./executor";
import type {
  PulseTreeDef,
  PulseExecution,
  PulseEvent,
  PulseResult,
  ValidationResult,
  ExecutionContext,
} from "../types/pulse";

export interface PulseRunnerOptions {
  defaultRetries?: number;
  defaultTimeout?: number;
}

export class PulseRunner extends EventEmitter {
  private parser = new TreeParser();
  private scheduler = new Scheduler();
  private executor = new Executor();
  private registry = new Map<string, (context: ExecutionContext) => Promise<any>>();
  private lastExecution?: PulseExecution;
  private options: PulseRunnerOptions;

  constructor(options?: PulseRunnerOptions) {
    super();
    this.options = options ?? {};
  }

  /** Register a function for a node ID */
  register(nodeId: string, fn: (context: ExecutionContext) => Promise<any>): void {
    this.registry.set(nodeId, fn);
  }

  /** Register multiple functions at once */
  registerAll(fns: Record<string, (context: ExecutionContext) => Promise<any>>): void {
    for (const [id, fn] of Object.entries(fns)) {
      this.registry.set(id, fn);
    }
  }

  /** Validate a tree definition without executing */
  validate(tree: PulseTreeDef): ValidationResult {
    return this.parser.validate(tree);
  }

  /** Get last execution state */
  getExecution(): PulseExecution | undefined {
    return this.lastExecution;
  }

  /** Get a specific node result from last execution */
  getResult(nodeId: string): PulseResult | undefined {
    return this.lastExecution?.results.get(nodeId);
  }

  /** Execute a tree definition */
  async run(tree: PulseTreeDef): Promise<PulseExecution> {
    return withRunLedger(tree.id, async () => {
      // Parse and validate
      const parsed = this.parser.parse(tree);
      const validation = this.parser.validate(parsed);
      if (!validation.valid) {
        throw new Error(
          `Tree validation failed:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`
        );
      }

      // Apply defaults
      for (const node of parsed.nodes) {
        if (node.retries === undefined && this.options.defaultRetries !== undefined) {
          node.retries = this.options.defaultRetries;
        }
        if (node.timeout === undefined && this.options.defaultTimeout !== undefined) {
          node.timeout = this.options.defaultTimeout;
        }
      }

      // Hydrate with functions
      const nodes = this.parser.hydrate(parsed, this.registry);

      // Initialize execution
      const execution: PulseExecution = {
        treeId: tree.id,
        startedAt: new Date(),
        results: new Map(),
        status: "running",
      };
      this.lastExecution = execution;

      // Initialize scheduler
      this.scheduler.initialize(nodes);

      // Execution loop
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      while (!this.scheduler.isComplete()) {
        const ready = this.scheduler.getReady();
        if (ready.length === 0) break;

        // Execute all ready nodes in parallel
        const promises = ready.map(async (nodeId) => {
          const node = nodeMap.get(nodeId)!;
          this.scheduler.markRunning(nodeId);

          // Build context with parent results
          const context: ExecutionContext = {
            parentResults: new Map(),
          };
          for (const dep of node.dependsOn ?? []) {
            const depResult = this.scheduler.getResult(dep);
            if (depResult?.result !== undefined) {
              context.parentResults.set(dep, depResult.result);
            }
          }

          // Emit start event
          const startEvent: PulseEvent = { type: "node-start", nodeId };
          this.emit("event", startEvent);

          const startTime = Date.now();

          // Execute with retry
          const result = await this.executor.execute(
            node,
            context,
            (attempt, willRetry, error) => {
              if (error) {
                const failEvent: PulseEvent = {
                  type: "node-failed",
                  nodeId,
                  error,
                  willRetry,
                };
                this.emit("event", failEvent);
              }
            }
          );

          const duration = Date.now() - startTime;

          if (result.status === "done") {
            this.scheduler.markDone(nodeId, result);
            execution.results.set(nodeId, result);
            const completeEvent: PulseEvent = {
              type: "node-complete",
              nodeId,
              result: result.result,
              duration,
            };
            this.emit("event", completeEvent);
          } else {
            this.scheduler.markFailed(nodeId, result);
            execution.results.set(nodeId, result);
            this.scheduler.skipSubtree(nodeId);
            // Add skipped results to execution
            for (const [id, skippedResult] of this.scheduler.getAllResults()) {
              if (!execution.results.has(id)) {
                execution.results.set(id, skippedResult);
              }
            }
          }
        });

        await Promise.all(promises);
      }

      // Finalize execution
      execution.completedAt = new Date();
      const hasFailed = [...execution.results.values()].some(
        (r) => r.status === "failed"
      );
      execution.status = hasFailed ? "failed" : "completed";

      // Emit tree complete
      const treeEvent: PulseEvent = {
        type: "tree-complete",
        treeId: tree.id,
        status: execution.status,
      };
      this.emit("event", treeEvent);

      this.lastExecution = execution;
      return execution;
    }, (execution) => ({
      outcome: execution.status === "completed" ? "succeeded" : "failed",
      startedAt: execution.startedAt.toISOString(),
      endedAt: execution.completedAt?.toISOString(),
    }));
  }
}
