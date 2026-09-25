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
  ActionStepEvent,
} from "./types/pipeline";
export { StdinGateProvider } from "./lib/gate-provider";

// Agent actions (iteration 6, P-600/P-601) — fleet tasks via myelin envelopes
export type {
  AgentStepSpec,
  AgentSovereignty,
  AgentTaskSpec,
  AgentTaskResult,
  AgentProvider,
  AgentEvent,
} from "./types/agent";
export {
  MyelinAgentProvider,
  MockAgentProvider,
  InMemoryAgentTransport,
  NatsAgentTransport,
  encodeDidSegment,
  subjectMatches,
} from "./lib/agent-provider";
export type { AgentTransport, MyelinAgentProviderConfig, MyelinEnvelope } from "./lib/agent-provider";
export { renderPromptTemplate } from "./lib/primitive-runner";
export { createLocalCapabilities, createCloudCapabilities, createLocalShell } from "./lib/capabilities";
export type { LocalCapabilityOptions } from "./lib/capabilities";

// Research step — a model researches through read-only actions (P-900..P-905)
export type { ResearchStepSpec, ResearchStats, ResearchEvent } from "./types/research";
export { ResearchUnavailable } from "./lib/research";
export { OpenAICompatibleChatModel, ModelUnavailableError, ModelError } from "./lib/chat-model";
export type {
  ChatModel,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatRequest,
  ChatResponse,
  OpenAICompatibleConfig,
} from "./lib/chat-model";
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
  ActionEffect,
  ActionInputField,
} from "./types/action";

// Verdict tribunal (governance Stage 3, P-701) — L1 of the governed-action stack
export type {
  TribunalStepSpec,
  SeatSpec,
  SeatVote,
  SeatVerdict,
  TribunalRuling,
  TribunalVerdict,
  TribunalDiversity,
  TribunalEvent,
} from "./types/tribunal";
export {
  parseSeatVote,
  abstainVote,
  aggregate,
  planDiversity,
  checkPosthocDiversity,
  applyDiversityDowngrade,
  VOTE_FORMAT_INSTRUCTION,
} from "./lib/tribunal";

// Governed actions (governance Stage 4, P-702) — the L0→L1→L2 stack as one step
export type {
  GovernedStepSpec,
  GovernedResult,
  GovernedEvent,
  GovernedTribunalSpec,
  GovernedGateSpec,
} from "./types/governed";

// Flow system (iteration 3) — the third primitive
export { runFlow, scheduleFlow, loadFlow } from "./lib/flow";

// Enforcement gate (governance Stage 1) — the runtime complement to manifests
export { evaluate } from "./lib/enforcement-gate";
export { loadPolicy, guardCapabilities, shellGateInput, DENY_ALL, PolicyDenial } from "./lib/policy-loader";
export type { GateAuditHook, GuardOptions, PolicyLoadResult } from "./lib/policy-loader";
export type { Policy, PolicyRule, Decision, GateDecision } from "./types/policy";

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
