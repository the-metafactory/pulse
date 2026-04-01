import { Command } from "commander";
import { PulseRunner } from "../lib/runner";
import type { PulseEvent } from "../types/pulse";

export function createRunCommand(): Command {
  return new Command("run")
    .description("Execute a tree from a JSON definition file")
    .argument("<file>", "Path to tree JSON file")
    .option("--dry-run", "Validate tree without executing")
    .action(async (file: string, opts: { dryRun?: boolean }) => {
      const json = await Bun.file(file).json();
      const runner = new PulseRunner();

      if (opts.dryRun) {
        const result = runner.validate(json);
        if (result.valid) {
          console.log(`Tree "${json.id}" is valid (${json.nodes.length} nodes)`);
        } else {
          console.error("Validation errors:");
          for (const err of result.errors) {
            console.error(`  [${err.code}] ${err.message}`);
          }
          process.exit(1);
        }
        return;
      }

      // Register placeholder functions (for CLI, actual functions would need to be loaded)
      console.error(
        "Note: CLI run requires functions registered programmatically.\n" +
        "Use --dry-run to validate tree structure, or use the API for execution."
      );
      process.exit(1);
    });
}

/** Run a tree with verbose event logging */
export async function runTreeWithEvents(
  runner: PulseRunner,
  tree: any,
  verbose: boolean
): Promise<void> {
  if (verbose) {
    runner.on("event", (event: PulseEvent) => {
      switch (event.type) {
        case "node-start":
          console.log(`  ▶ ${event.nodeId}`);
          break;
        case "node-complete":
          console.log(`  ✓ ${event.nodeId} (${event.duration}ms)`);
          break;
        case "node-failed":
          console.log(
            `  ✗ ${event.nodeId}: ${event.error.message}${event.willRetry ? " (retrying)" : ""}`
          );
          break;
        case "tree-complete":
          console.log(`\nTree "${event.treeId}" ${event.status}`);
          break;
      }
    });
  }

  const execution = await runner.run(tree);
  const succeeded = [...execution.results.values()].filter(
    (r) => r.status === "done"
  ).length;
  const total = execution.results.size;
  const duration = execution.completedAt!.getTime() - execution.startedAt.getTime();

  console.log(
    `Pulse: ${execution.status === "completed" ? "Completed" : "Failed"} in ${duration}ms (${succeeded}/${total} succeeded)`
  );
}
