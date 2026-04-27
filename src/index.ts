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
export { runSteps, runStep, StepFailure, MapItemFailure, validateSteps, validateStep } from "./lib/step-runner";
export type { StepRecord, StepRunnerOptions } from "./lib/step-runner";
export type {
  PipelineStep,
  MapStepSpec,
  FilterStepSpec,
  ReduceStepSpec,
  ParallelStepSpec,
  RetryStepSpec,
  GateStepSpec,
  GateProvider,
  GateInput,
  GateResult,
  GateVerdict,
  GateEvent,
} from "./types/pipeline";
export { StdinGateProvider } from "./lib/gate-provider";
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

// Flow system (iteration 3) — the third primitive
export { runFlow, scheduleFlow, loadFlow } from "./lib/flow";

// Arc integration (iteration 3) — discover arc-installed packages
export { discoverArcActions, discoverArcPipelines, discoverArcFlows, createArcActionDirs } from "./lib/arc";
export type { ArcAction, ArcPipeline, ArcFlow } from "./lib/arc";
export type {
  FlowDef,
  FlowResult,
  FlowSource,
  FlowDestination,
  FlowSchedule,
} from "./types/flow";
