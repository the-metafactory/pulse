/**
 * Flow — Source → Pipeline → Destination.
 *
 * The third primitive in the Action/Pipeline/Flow hierarchy.
 * Flows are the top-level orchestrators: they fetch data from a source,
 * run it through a pipeline, and write the result to a destination.
 */

import { runPipeline, loadPipeline, type PipelineDef } from "./pipeline";
import type { ActionRunnerOptions } from "./action-runner";
import type {
  FlowDef,
  FlowResult,
  FlowSource,
  FlowDestination,
} from "../types/flow";

// ---------------------------------------------------------------------------
// Source adapters — fetch data from various sources
// ---------------------------------------------------------------------------

async function fetchSource(source: FlowSource): Promise<Record<string, unknown>> {
  switch (source.type) {
    case "rss":
      return { feedUrl: source.url, limit: source.limit ?? 5 };

    case "file": {
      const file = Bun.file(source.path);
      if (!(await file.exists())) {
        throw new Error(`Source file not found: ${source.path}`);
      }
      const content = await file.text();
      try {
        return JSON.parse(content);
      } catch {
        return { content, path: source.path };
      }
    }

    case "inline":
      return source.data;

    case "custom":
      return source.fn();

    case "webhook":
      // Webhook sources are triggered externally — return empty for now.
      // A real implementation would start an HTTP server and wait.
      throw new Error("Webhook sources require a server runtime (use runFlowServer)");

    default:
      throw new Error(`Unknown source type: ${(source as any).type}`);
  }
}

// ---------------------------------------------------------------------------
// Destination adapters — write results to various targets
// ---------------------------------------------------------------------------

async function writeDestination(
  dest: FlowDestination,
  output: Record<string, unknown>
): Promise<void> {
  switch (dest.type) {
    case "stdout":
      console.log(JSON.stringify(output, null, 2));
      break;

    case "file": {
      const content = dest.format === "markdown" && typeof output.digest === "string"
        ? output.digest
        : JSON.stringify(output, null, 2);
      await Bun.write(dest.path, content);
      break;
    }

    case "webhook": {
      const response = await fetch(dest.url, {
        method: dest.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...dest.headers,
        },
        body: JSON.stringify(output),
      });
      if (!response.ok) {
        throw new Error(`Webhook destination failed: ${response.status} ${response.statusText}`);
      }
      break;
    }

    case "custom":
      await dest.fn(output);
      break;

    default:
      throw new Error(`Unknown destination type: ${(dest as any).type}`);
  }
}

// ---------------------------------------------------------------------------
// Flow runner
// ---------------------------------------------------------------------------

/**
 * Run a flow once: fetch source → run pipeline → write destination.
 */
export async function runFlow(
  flow: FlowDef,
  options: Omit<ActionRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
  }
): Promise<FlowResult> {
  const startTime = Date.now();
  const result: Partial<FlowResult> = {
    flowName: flow.name,
    destinationWritten: false,
  };

  // Stage 1: Fetch source data
  let sourceData: Record<string, unknown>;
  try {
    sourceData = await fetchSource(flow.source);
    // Merge with static input
    if (flow.input) {
      sourceData = { ...sourceData, ...flow.input };
    }
    result.sourceData = sourceData;
  } catch (err) {
    return {
      ...result,
      flowName: flow.name,
      success: false,
      destinationWritten: false,
      error: err instanceof Error ? err.message : String(err),
      failedStage: "source",
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
  }

  // Stage 2: Resolve and run pipeline
  let pipelineDef: PipelineDef;
  let actionDirs = options.actionDirs || [];

  if (typeof flow.pipeline === "string") {
    // Named pipeline — try to load from YAML
    // First check if it's a path to a pipeline.yaml
    try {
      const loaded = await loadPipeline(flow.pipeline);
      pipelineDef = loaded.pipeline;
      actionDirs = [loaded.baseDir, ...actionDirs];
    } catch {
      // Treat as a pipeline name — caller must provide actionDirs
      pipelineDef = { name: flow.pipeline, actions: [] };
      throw new Error(
        `Pipeline "${flow.pipeline}" could not be loaded. Provide a path to pipeline.yaml or use an inline pipeline definition.`
      );
    }
  } else {
    // Inline pipeline definition
    pipelineDef = { name: `${flow.name}_pipeline`, actions: flow.pipeline.actions };
  }

  try {
    const pipelineResult = await runPipeline(pipelineDef, sourceData, {
      ...options,
      actionDirs,
      mode: flow.mode,
    });

    if (!pipelineResult.success) {
      return {
        ...result,
        flowName: flow.name,
        success: false,
        destinationWritten: false,
        pipelineOutput: pipelineResult.output,
        error: pipelineResult.steps.find((s) => !s.success)?.error || "Pipeline failed",
        failedStage: "pipeline",
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };
    }

    result.pipelineOutput = pipelineResult.output;
  } catch (err) {
    return {
      ...result,
      flowName: flow.name,
      success: false,
      destinationWritten: false,
      error: err instanceof Error ? err.message : String(err),
      failedStage: "pipeline",
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
  }

  // Stage 3: Write to destination
  try {
    await writeDestination(flow.destination, result.pipelineOutput!);
    result.destinationWritten = true;
  } catch (err) {
    return {
      ...result,
      flowName: flow.name,
      success: false,
      destinationWritten: false,
      error: err instanceof Error ? err.message : String(err),
      failedStage: "destination",
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
  }

  return {
    ...result,
    flowName: flow.name,
    success: true,
    destinationWritten: true,
    durationMs: Date.now() - startTime,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scheduled flow runner
// ---------------------------------------------------------------------------

/**
 * Run a flow on a schedule. Returns a stop function.
 *
 * For cron expressions, uses simple interval approximation locally.
 * For production cron, use Cloudflare Workers cron triggers or system crontab.
 */
export function scheduleFlow(
  flow: FlowDef,
  options: Omit<ActionRunnerOptions, "actionDirs"> & {
    actionDirs?: string[];
    onRun?: (result: FlowResult) => void;
    onError?: (error: Error) => void;
  }
): { stop: () => void } {
  const schedule = flow.schedule;
  if (!schedule) {
    throw new Error(`Flow "${flow.name}" has no schedule defined`);
  }

  let intervalMs: number;

  if (schedule.intervalSeconds) {
    intervalMs = schedule.intervalSeconds * 1000;
  } else if (schedule.cron) {
    // Simple cron approximation for local scheduling
    intervalMs = parseCronToMs(schedule.cron);
  } else {
    throw new Error("Schedule must specify either cron or intervalSeconds");
  }

  const timer = setInterval(async () => {
    try {
      const result = await runFlow(flow, options);
      options.onRun?.(result);
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }, intervalMs);

  // Run immediately on first tick
  runFlow(flow, options)
    .then((result) => options.onRun?.(result))
    .catch((err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));

  return {
    stop: () => clearInterval(timer),
  };
}

/**
 * Simple cron-to-milliseconds approximation.
 * Handles common patterns; for full cron support use a cron library.
 */
function parseCronToMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${cron}" (expected 5 fields)`);
  }

  const [minute, hour] = parts;

  // "*/N * * * *" = every N minutes
  if (minute.startsWith("*/") && hour === "*") {
    return parseInt(minute.slice(2)) * 60 * 1000;
  }

  // "0 */N * * *" = every N hours
  if (minute === "0" && hour.startsWith("*/")) {
    return parseInt(hour.slice(2)) * 60 * 60 * 1000;
  }

  // "0 * * * *" = every hour
  if (minute === "0" && hour === "*") {
    return 60 * 60 * 1000;
  }

  // Default: run every hour for unrecognized patterns
  return 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Flow YAML loader
// ---------------------------------------------------------------------------

/**
 * Load a flow definition from a flow.yaml file.
 */
export async function loadFlow(yamlPath: string): Promise<FlowDef> {
  const file = Bun.file(yamlPath);
  if (!(await file.exists())) {
    throw new Error(`Flow file not found: ${yamlPath}`);
  }

  const content = await file.text();
  const parsed = parseFlowYaml(content);

  if (!parsed.name) throw new Error(`Flow YAML missing 'name': ${yamlPath}`);
  if (!parsed.source) throw new Error(`Flow YAML missing 'source': ${yamlPath}`);
  if (!parsed.pipeline) throw new Error(`Flow YAML missing 'pipeline': ${yamlPath}`);
  if (!parsed.destination) throw new Error(`Flow YAML missing 'destination': ${yamlPath}`);

  return parsed;
}

/**
 * Minimal flow YAML parser.
 * Handles the nested structure needed for source/destination/schedule.
 */
function parseFlowYaml(content: string): FlowDef {
  const result: Record<string, any> = {};
  let currentSection: string | null = null;
  let sectionData: Record<string, any> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level key (no indent): "name:", "source:", etc.
    const topMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (topMatch) {
      // Save previous section
      if (currentSection && Object.keys(sectionData).length > 0) {
        result[currentSection] = sectionData;
        sectionData = {};
      }

      const [, key, rawValue] = topMatch;
      const value = rawValue.trim().replace(/^["']|["']$/g, "");

      if (value) {
        // Simple key-value
        result[key] = value;
        currentSection = null;
      } else {
        // Start of nested section
        currentSection = key;
        sectionData = {};
      }
      continue;
    }

    // Nested key (indented): "  type: rss"
    const nestedMatch = line.match(/^\s+(\w[\w_-]*):\s*(.*)/);
    if (nestedMatch && currentSection) {
      const [, key, rawValue] = nestedMatch;
      let value: any = rawValue.trim().replace(/^["']|["']$/g, "");
      // Parse numbers
      if (/^\d+$/.test(value)) value = parseInt(value);
      sectionData[key] = value;
    }
  }

  // Save last section
  if (currentSection && Object.keys(sectionData).length > 0) {
    result[currentSection] = sectionData;
  }

  // Build FlowDef from parsed data
  const flow: FlowDef = {
    name: result.name,
    description: result.description,
    source: result.source as FlowSource,
    pipeline: result.pipeline_actions
      ? { actions: result.pipeline_actions.split(",").map((s: string) => s.trim()) }
      : result.pipeline,
    destination: result.destination as FlowDestination,
    mode: result.mode,
  };

  if (result.schedule) {
    flow.schedule = result.schedule;
  }

  return flow;
}
