/**
 * Action Runner — load and execute actions locally or dispatch to cloud.
 *
 * Adapted from Daniel Miessler's PAI runner.ts and runner.v2.ts
 * (github.com/danielmiessler/PAI). The core insight: actions declare
 * capabilities they need, the runtime injects implementations. Same
 * action code runs on Bun locally or on Cloudflare Workers.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { createLocalCapabilities } from "./capabilities";
import { guardCapabilities, type GateAuditHook } from "./policy-loader";
import type { Policy } from "../types/policy";
import type {
  ActionManifest,
  ActionImplementation,
  ActionContext,
  ActionResult,
} from "../types/action";
import type { AgentProvider } from "../types/agent";

export interface ActionRunnerOptions {
  /** Directories to search for actions (checked in order, first match wins) */
  actionDirs: string[];
  /** Default execution mode */
  defaultMode?: "local" | "cloud";
  /** Cloud worker URL pattern. Use {name} as placeholder. */
  cloudUrlPattern?: string;
  /**
   * Agent task dispatcher, injected as the `agent` capability for actions
   * that declare `requires: ["agent"]`. Also consumed by `agent:` pipeline
   * steps. No default — a missing provider fails fast at execution time.
   */
  agentProvider?: AgentProvider;
  /**
   * Optional enforcement policy (Stage 1). When set, blast-radius capabilities
   * (shell/fetch/writeFile/readFile) are guarded: each call passes the
   * fail-closed gate before running. Absent → capabilities run unguarded
   * (backward-compatible; opt in per host).
   */
  policy?: Policy;
  /** Called on every non-allow gate decision — wire to audit logging. */
  onGateDecision?: GateAuditHook;
}

/**
 * Load an action manifest (action.json) from a directory.
 */
async function loadManifest(actionPath: string): Promise<ActionManifest> {
  const file = Bun.file(join(actionPath, "action.json"));
  return file.json();
}

/**
 * Load an action implementation (action.ts) from a directory.
 */
async function loadImplementation<TInput, TOutput>(
  actionPath: string
): Promise<ActionImplementation<TInput, TOutput>> {
  const module = await import(join(actionPath, "action.ts"));
  return module.default as ActionImplementation<TInput, TOutput>;
}

/**
 * Find an action directory by name.
 * Searches actionDirs in order — first match wins (allows user overrides).
 */
async function findAction(name: string, dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      const file = Bun.file(join(path, "action.json"));
      if (await file.exists()) return path;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Run a single action with capability injection.
 *
 * Local mode: loads action from disk, injects local capabilities, executes.
 * Cloud mode: dispatches to Cloudflare Worker via HTTPS POST.
 */
export async function runAction<TInput = Record<string, unknown>, TOutput = unknown>(
  name: string,
  input: TInput,
  options: ActionRunnerOptions & { mode?: "local" | "cloud"; traceId?: string }
): Promise<ActionResult<TOutput>> {
  const startTime = Date.now();
  const mode = options.mode || options.defaultMode || "local";

  if (mode === "cloud") {
    return dispatchToCloud<TInput, TOutput>(name, input, options, startTime);
  }

  // Local execution
  const actionPath = await findAction(name, options.actionDirs);
  if (!actionPath) {
    return { success: false, error: `Action not found: ${name}` };
  }

  try {
    const manifest = await loadManifest(actionPath);
    const implementation = await loadImplementation<TInput, TOutput>(actionPath);

    // Validate required inputs
    const inputObj = input as Record<string, unknown>;
    for (const [field, spec] of Object.entries(manifest.input)) {
      if (spec.required && (inputObj[field] === undefined || inputObj[field] === null)) {
        return { success: false, error: `Missing required input: ${field}` };
      }
    }

    // Create capabilities for what this action needs
    const capabilities = await createLocalCapabilities(manifest.requires);

    // Agent dispatch comes from the host-configured provider, not the
    // environment — same injection rule as every other capability.
    if (manifest.requires?.includes("agent")) {
      const provider = options.agentProvider;
      if (!provider) {
        return {
          success: false,
          error: `Action ${name} requires 'agent' capability but no agentProvider is configured`,
        };
      }
      capabilities.agent = (task) => provider.dispatch(task);
    }

    // Stage 1 — enforcement gate. When a policy is configured, guard the
    // blast-radius capabilities so each call passes the fail-closed gate
    // before it runs. The manifest declares; the gate bites.
    const guardedCapabilities = options.policy
      ? guardCapabilities(capabilities, { policy: options.policy, onDecision: options.onGateDecision })
      : capabilities;

    const ctx: ActionContext = {
      capabilities: guardedCapabilities,
      env: { mode: "local" },
      trace: options.traceId
        ? { traceId: options.traceId, spanId: crypto.randomUUID().slice(0, 8) }
        : undefined,
    };

    const output = await implementation.execute(input, ctx);

    return {
      success: true,
      output,
      metadata: {
        durationMs: Date.now() - startTime,
        action: manifest.name,
        mode: "local",
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      metadata: {
        durationMs: Date.now() - startTime,
        action: name,
        mode: "local",
      },
    };
  }
}

/**
 * Dispatch an action to a Cloudflare Worker via HTTPS POST.
 */
async function dispatchToCloud<TInput, TOutput>(
  name: string,
  input: TInput,
  options: ActionRunnerOptions & { traceId?: string },
  startTime: number
): Promise<ActionResult<TOutput>> {
  const pattern = options.cloudUrlPattern || "https://pulse-{name}.workers.dev";
  const workerUrl = pattern.replace("{name}", name.toLowerCase().replace(/_/g, "-"));

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.traceId) headers["X-Trace-Id"] = options.traceId;

    const response = await fetch(workerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Worker error (${response.status}): ${error}`,
        metadata: { durationMs: Date.now() - startTime, action: name, mode: "cloud" },
      };
    }

    const output = (await response.json()) as TOutput;
    return {
      success: true,
      output,
      metadata: { durationMs: Date.now() - startTime, action: name, mode: "cloud" },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      metadata: { durationMs: Date.now() - startTime, action: name, mode: "cloud" },
    };
  }
}

/**
 * List all available actions from configured directories.
 * Earlier directories take precedence (user overrides system).
 */
export async function listActions(dirs: string[]): Promise<ActionManifest[]> {
  const manifests: ActionManifest[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        try {
          const manifest = await loadManifest(join(dir, entry.name));
          manifests.push(manifest);
          seen.add(entry.name);
        } catch {
          // Not an action directory, skip
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return manifests;
}
