import { Command } from "commander";
import { loadFlow, runFlow } from "../lib/flow";
import { discoverArcFlows, createArcActionDirs } from "../lib/arc";
import { join, resolve, dirname } from "path";
import type { FlowDef } from "../types/flow";

interface ResolvedFlow {
  flow: FlowDef;
  resolvedDir: string | undefined;
}

/**
 * Create the `pulse flow` command group.
 *
 * - pulse flow list              — discover and list installed flows
 * - pulse flow <name>            — execute a named flow
 * - pulse flow <name> --dry-run  — validate without executing
 */
export function createFlowCommand(): Command {
  const flow = new Command("flow")
    .description("Discover and run installed flows");

  // --- pulse flow list ---
  flow
    .command("list")
    .description("List all installed flows from arc packages")
    .action(async () => {
      const flows = await discoverArcFlows();

      if (flows.length === 0) {
        console.log("No flows found in arc-installed packages.");
        return;
      }

      console.log(`Found ${flows.length} flow${flows.length === 1 ? "" : "s"}:\n`);
      for (const f of flows) {
        console.log(`  ${f.flow.name}`);
        if (f.flow.description) {
          console.log(`    ${f.flow.description}`);
        }
        console.log(`    package: ${f.packageName}`);
        console.log(`    path:    ${f.yamlPath}`);
        console.log();
      }
    });

  // --- pulse flow <name> ---
  flow
    .command("run", { isDefault: true })
    .description("Execute a named flow")
    .argument("<name>", "Flow name (e.g. F_NEXT_PICK) or path to flow.yaml")
    .option("--dry-run", "Validate flow without executing")
    .allowUnknownOption(true)
    .action(async (name: string, opts: { dryRun?: boolean }, cmd: Command) => {
      let resolved: ResolvedFlow;
      try {
        resolved = await resolveFlow(name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const { flow: flowDef, resolvedDir } = resolved;

      if (opts.dryRun) {
        const pipelineDisplay = typeof flowDef.pipeline === "string"
          ? (resolvedDir && flowDef.pipeline.startsWith("./") ? join(resolvedDir, flowDef.pipeline) : flowDef.pipeline)
          : flowDef.pipeline.actions.join(" → ");

        console.log(`Flow "${flowDef.name}" is valid`);
        console.log(`  source:      ${flowDef.source.type}`);
        console.log(`  pipeline:    ${pipelineDisplay}`);
        console.log(`  destination: ${flowDef.destination.type}`);
        if (flowDef.schedule) {
          console.log(`  schedule:    ${flowDef.schedule.cron || `every ${flowDef.schedule.intervalSeconds}s`}`);
        }
        return;
      }

      // Collect passthrough args as flow input
      const passthroughInput = parsePassthroughArgs(cmd.args.slice(1));

      // Build action dirs from arc packages
      const arcDirs = await createArcActionDirs();

      // Include the flow's directory for action resolution
      const actionDirs = resolvedDir ? [resolvedDir, ...arcDirs] : arcDirs;

      // Merge passthrough args into flow input
      if (Object.keys(passthroughInput).length > 0) {
        flowDef.input = { ...flowDef.input, ...passthroughInput };
      }

      // Resolve relative pipeline paths against the flow's directory
      if (typeof flowDef.pipeline === "string" && flowDef.pipeline.startsWith("./") && resolvedDir) {
        flowDef.pipeline = join(resolvedDir, flowDef.pipeline);
      }

      const result = await runFlow(flowDef, { actionDirs });

      if (!result.success) {
        console.error(`Flow "${result.flowName}" failed at ${result.failedStage}: ${result.error}`);
        process.exit(1);
      }

      console.error(`Flow "${result.flowName}" completed in ${result.durationMs}ms`);
    });

  return flow;
}

/**
 * Resolve a flow by name (from arc packages) or by file path.
 */
async function resolveFlow(nameOrPath: string): Promise<ResolvedFlow> {
  // If it looks like a path, load directly
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml")) {
    const flowDef = await loadFlow(resolve(nameOrPath));
    return { flow: flowDef, resolvedDir: dirname(resolve(nameOrPath)) };
  }

  // Search arc-installed flows by name
  const flows = await discoverArcFlows();
  const match = flows.find((f) => f.flow.name === nameOrPath);

  if (!match) {
    const available = flows.map((f) => f.flow.name);
    const hint = available.length > 0
      ? `Available flows: ${available.join(", ")}`
      : "No flows installed. Install a package with arc first.";
    throw new Error(`Flow "${nameOrPath}" not found. ${hint}`);
  }

  return { flow: match.flow, resolvedDir: match.baseDir };
}

/**
 * Parse remaining CLI args as key=value pairs or --key value pairs into a record.
 * Coerces numeric-looking values to numbers.
 */
function parsePassthroughArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      // --key=value
      if (key.includes("=")) {
        const [k, ...vParts] = key.split("=");
        result[k] = coerceValue(vParts.join("="));
      }
      // --key value (next arg is the value, unless it's another flag)
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = coerceValue(args[i + 1]);
        i++;
      }
      // --flag (boolean)
      else {
        result[key] = true;
      }
    }
    i++;
  }

  return result;
}

/** Coerce string values to numbers/booleans where unambiguous. */
function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (value !== "" && !isNaN(num)) return num;
  return value;
}
