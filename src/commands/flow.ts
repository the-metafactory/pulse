import { Command } from "commander";
import { loadFlow, runFlow } from "../lib/flow";
import { discoverArcFlows, createArcActionDirs } from "../lib/arc";
import { join, resolve, dirname } from "path";

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
      // Resolve the flow: either by name from arc packages, or by path
      const flowDef = await resolveFlow(name);

      if (opts.dryRun) {
        console.log(`Flow "${flowDef.name}" is valid`);
        console.log(`  source:      ${(flowDef.source as any).type}`);
        console.log(`  pipeline:    ${typeof flowDef.pipeline === "string" ? flowDef.pipeline : flowDef.pipeline.actions.join(" → ")}`);
        console.log(`  destination: ${(flowDef.destination as any).type}`);
        if (flowDef.schedule) {
          console.log(`  schedule:    ${flowDef.schedule.cron || `every ${flowDef.schedule.intervalSeconds}s`}`);
        }
        return;
      }

      // Collect passthrough args as flow input
      const passthroughInput = parsePassthroughArgs(cmd.args.slice(1));

      // Build action dirs from arc packages
      const arcDirs = await createArcActionDirs();

      // If the flow was loaded from a file, include its directory for action resolution
      const flowDir = flowDef._resolvedDir;
      const actionDirs = flowDir ? [flowDir, ...arcDirs] : arcDirs;

      // Merge passthrough args into flow input
      if (Object.keys(passthroughInput).length > 0) {
        flowDef.input = { ...flowDef.input, ...passthroughInput };
      }

      // Resolve relative pipeline paths against the flow's directory
      if (typeof flowDef.pipeline === "string" && flowDef.pipeline.startsWith("./") && flowDir) {
        flowDef.pipeline = join(flowDir, flowDef.pipeline);
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
async function resolveFlow(nameOrPath: string): Promise<any> {
  // If it looks like a path, load directly
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml")) {
    const flow = await loadFlow(resolve(nameOrPath));
    return { ...flow, _resolvedDir: dirname(resolve(nameOrPath)) };
  }

  // Search arc-installed flows by name
  const flows = await discoverArcFlows();
  const match = flows.find((f) => f.flow.name === nameOrPath);

  if (!match) {
    console.error(`Flow "${nameOrPath}" not found.`);
    const available = flows.map((f) => f.flow.name);
    if (available.length > 0) {
      console.error(`Available flows: ${available.join(", ")}`);
    } else {
      console.error("No flows installed. Install a package with arc first.");
    }
    process.exit(1);
  }

  return { ...match.flow, _resolvedDir: match.baseDir };
}

/**
 * Parse remaining CLI args as key=value pairs or --key value pairs into a record.
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
        result[k] = vParts.join("=");
      }
      // --key value (next arg is the value, unless it's another flag)
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[i + 1];
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
