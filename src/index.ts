// Tree runner (iteration 1)
export { PulseRunner } from "./lib/runner";
export type { PulseRunnerOptions } from "./lib/runner";
export { TreeParser } from "./lib/parser";
export { Scheduler } from "./lib/scheduler";
export { Executor } from "./lib/executor";
export { detectCycles } from "./lib/cycles";
export { PulseTreeDefSchema, PulseNodeDefSchema } from "./schemas/tree";
export type {
  PulseTreeDef,
  PulseNodeDef,
  PulseNode,
  NodeStatus,
  PulseResult,
  PulseExecution,
  PulseEvent,
  ExecutionContext,
  ValidationResult,
  ValidationError,
} from "./types/pulse";

// Action system (iteration 2) — inspired by Daniel Miessler's PAI
export { runAction, listActions } from "./lib/action-runner";
export type { ActionRunnerOptions } from "./lib/action-runner";
export { runPipeline, loadPipeline, runPipelineFromYaml, discoverPipelines } from "./lib/pipeline";
export type { PipelineDef, PipelineResult } from "./lib/pipeline";
export { createLocalCapabilities, createCloudCapabilities } from "./lib/capabilities";
export type {
  ActionCapabilities,
  CapabilityName,
  ActionManifest,
  ActionContext,
  ActionImplementation,
  ActionResult,
  LLMOptions,
  LLMResponse,
  ShellResult,
} from "./types/action";
