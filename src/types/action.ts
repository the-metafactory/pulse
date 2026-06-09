/**
 * Pulse Action System — Typed actions with capability injection.
 *
 * Inspired by Daniel Miessler's PAI Actions framework (github.com/danielmiessler/PAI),
 * which pioneered the pattern of portable, capability-injected actions that run
 * transparently on local runtimes or Cloudflare Workers.
 *
 * Pulse generalizes this into the metafactory ecosystem's execution engine.
 */

import type { AgentTaskSpec, AgentTaskResult } from "./agent";

// ---------------------------------------------------------------------------
// Capabilities — what actions can request from the runtime
// ---------------------------------------------------------------------------

export interface ActionCapabilities {
  /** LLM inference — prompt in, response out */
  llm?: (prompt: string, options?: LLMOptions) => Promise<LLMResponse>;

  /**
   * Agent task dispatch — capability-addressed, sovereignty-constrained work
   * executed by the fleet (myelin envelopes over NATS). Unlike `llm` (a
   * synchronous, stateless completion), an agent task is routed by the bus
   * and tracked through the dispatch lifecycle. See src/types/agent.ts.
   */
  agent?: (task: AgentTaskSpec) => Promise<AgentTaskResult>;

  /** HTTP fetch */
  fetch?: typeof globalThis.fetch;

  /** Shell command execution */
  shell?: (cmd: string) => Promise<ShellResult>;

  /** File read (sandboxed to allowed paths) */
  readFile?: (path: string) => Promise<string>;

  /** File write (sandboxed to allowed paths) */
  writeFile?: (path: string, content: string) => Promise<void>;

  /** Key-value storage */
  kv?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, ttl?: number) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
}

export type CapabilityName = "llm" | "agent" | "fetch" | "shell" | "readFile" | "writeFile" | "kv";

export interface LLMOptions {
  /** Model tier: fast (haiku), standard (sonnet), smart (opus) */
  tier?: "fast" | "standard" | "smart";
  /** System prompt */
  system?: string;
  /** Expect JSON response */
  json?: boolean;
  /** Max tokens */
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;
  json?: unknown;
  usage?: { input: number; output: number };
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

// ---------------------------------------------------------------------------
// Action Manifest — the action.json file
// ---------------------------------------------------------------------------

export interface ActionManifest {
  /** Unique name (e.g. "A_EXTRACT_ARTICLE") */
  name: string;

  /** Semantic version */
  version: string;

  /** Human-readable description */
  description: string;

  /** Input field declarations */
  input: Record<string, { type: string; required?: boolean }>;

  /** Output field declarations */
  output: Record<string, { type: string }>;

  /** Capabilities this action requires from the runtime */
  requires?: CapabilityName[];

  /** Tags for categorization and discovery */
  tags?: string[];

  /** Author attribution */
  author?: { name: string; url?: string };

  /** License identifier */
  license?: string;

  /** Deployment hints for cloud execution */
  deployment?: {
    timeout?: number;
    memory?: number;
    secrets?: string[];
  };
}

// ---------------------------------------------------------------------------
// Action Context — passed to every action at execution time
// ---------------------------------------------------------------------------

export interface ActionContext {
  /** Injected capabilities based on action's requirements */
  capabilities: ActionCapabilities;

  /** Execution environment */
  env: {
    mode: "local" | "cloud";
  };

  /** Trace context for observability */
  trace?: {
    traceId: string;
    spanId: string;
  };

  /** Pipeline context when running inside a pipeline */
  pipeline?: {
    name: string;
    stepIndex: number;
  };
}

// ---------------------------------------------------------------------------
// Action Implementation — what an action.ts exports
// ---------------------------------------------------------------------------

/**
 * The execute function signature.
 *
 * Actions use the passthrough pattern: destructure what you need from input,
 * spread the rest as `payload`, and return `{...payload, ...yourFields}`.
 *
 * ```typescript
 * async execute(input, ctx) {
 *   const { content, ...payload } = input;
 *   const summary = await ctx.capabilities.llm!(content, { tier: "fast" });
 *   return { ...payload, summary: summary.text };
 * }
 * ```
 */
export interface ActionImplementation<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
  execute: (input: TInput, ctx: ActionContext) => Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Action Result — wrapper returned by the runner
// ---------------------------------------------------------------------------

export interface ActionResult<T = unknown> {
  success: boolean;
  output?: T;
  error?: string;
  metadata?: {
    durationMs: number;
    action: string;
    mode: "local" | "cloud";
  };
}
