/**
 * Policy loading + capability guarding — the host adapter around the pure gate.
 *
 * `loadPolicy` reads a policy.json fail-closed (any error → a deny-all policy).
 * `guardCapabilities` wraps the injected capabilities so each guarded tool call
 * passes through `evaluate` before it runs — the manifest declares, this bites.
 *
 * Tool-name mapping (capability → policy tool, matched field):
 *   shell     → "Bash"  (match: command, form, program, argv — see shellGateInput)
 *   fetch     → "Fetch" (match: url)
 *   writeFile → "Write" (match: path)
 *   readFile  → "Read"  (match: path)
 *   llm       → "LLM"   (match: model — the injected model's label, or
 *                        "fallback" for the claude -p / PAI / API chain;
 *                        never the prompt, which the audit hook would see)
 *
 * `ask` has no host prompt at the capability layer (pulse runs autonomously),
 * so a guarded call resolving to `ask` is treated as `deny` with a clear
 * reason. A future GateProvider-style prompt can relax this; failing closed
 * is the safe default until then.
 */

import type { ActionCapabilities, LLMOptions } from "../types/action";
import type { GateDecision, Policy } from "../types/policy";
import { evaluate } from "./enforcement-gate";
import { llmModelLabel } from "./capabilities";

/** A policy that denies everything — the fail-closed fallback for any load error. */
export const DENY_ALL: Policy = { version: 1, default: "deny", rules: [] };

export interface PolicyLoadResult {
  policy: Policy;
  /** True when the on-disk policy loaded cleanly; false when we fell back to DENY_ALL. */
  ok: boolean;
  /** Populated when ok is false. */
  error?: string;
}

/**
 * Load a policy from disk, fail-closed. Any problem — missing file, unreadable,
 * malformed JSON, wrong shape — resolves to DENY_ALL, never throws. The caller
 * can inspect `ok`/`error` for diagnostics but the returned policy is always safe.
 */
export async function loadPolicy(path: string): Promise<PolicyLoadResult> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { policy: DENY_ALL, ok: false, error: "policy is not an object" };
    }
    const p = parsed as Policy;
    if (typeof p.version !== "number") {
      return { policy: DENY_ALL, ok: false, error: "policy.version missing or not a number" };
    }
    if (p.rules !== undefined && !Array.isArray(p.rules)) {
      return { policy: DENY_ALL, ok: false, error: "policy.rules is not an array" };
    }
    return { policy: p, ok: true };
  } catch (err) {
    return { policy: DENY_ALL, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hook fired on every gate decision — wire to append-only logging / bus emission. */
export type GateAuditHook = (event: {
  tool: string;
  input: Record<string, unknown>;
  decision: GateDecision;
}) => void;

export interface GuardOptions {
  policy: Policy;
  /** Called on every non-allow decision (and optionally all decisions). */
  onDecision?: GateAuditHook;
  /** When true, audit-parity mode: log denies but let calls through (Stage 1b ships this first). */
  auditOnly?: boolean;
}

class PolicyDenial extends Error {
  constructor(tool: string, decision: GateDecision) {
    super(`enforcement gate denied ${tool}: ${decision.reason}`);
    this.name = "PolicyDenial";
  }
}

/**
 * Guard a single async capability call: evaluate, audit, then run or refuse.
 * The four guarded capabilities (shell/fetch/writeFile/readFile) are all
 * promise-returning, so a denial REJECTS the promise rather than throwing
 * synchronously — callers `await` the capability and see a clean rejection.
 */
function guard<TArgs extends unknown[], TReturn>(
  tool: string,
  toInput: (...args: TArgs) => Record<string, unknown>,
  fn: (...args: TArgs) => Promise<TReturn>,
  opts: GuardOptions,
): (...args: TArgs) => Promise<TReturn> {
  return (...args: TArgs): Promise<TReturn> => {
    const input = toInput(...args);
    const decision = evaluate(tool, input, opts.policy);
    if (decision.decision !== "allow") {
      // The audit hook receives the TRUE decision: `decision.decision` is
      // "ask" when the policy said ask (and the capability layer is treating
      // it as deny for lack of a prompt) vs "deny" for a hard refusal. An
      // audit consumer distinguishes "would have prompted a human" from
      // "blocked outright" on that field — informs whether to add a prompt flow.
      opts.onDecision?.({ tool, input, decision });
      if (!opts.auditOnly) {
        return Promise.reject(new PolicyDenial(tool, decision));
      }
    }
    return fn(...args);
  };
}

/** Quote one argv element the way a POSIX shell would read it back. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The gate input for a shell call. Both forms carry `command` (argv is
 * shell-quoted, so a rule written against command strings reads an argv call
 * unambiguously) and `form` (`string` or `argv`), so a policy can deny the
 * `sh -c` form outright. The argv form adds `program` (argv[0], match it
 * with an anchored regex to pin the binary) and `argv` (the JSON array).
 */
export function shellGateInput(cmd: string | string[]): Record<string, unknown> {
  if (Array.isArray(cmd)) {
    return { command: cmd.map(shellQuote).join(" "), form: "argv", program: cmd[0] ?? "", argv: cmd };
  }
  return { command: cmd, form: "string" };
}

/**
 * Wrap injected capabilities so every guarded tool call passes the gate first.
 * Only the capabilities present on the object are wrapped; absent ones stay
 * absent (an action never gains a capability it didn't request). `llm` is
 * guarded by the model it reaches, so a policy can pin an action to one model
 * and deny the fallback chain. `agent` and `kv` pass through unwrapped.
 */
export function guardCapabilities(caps: ActionCapabilities, opts: GuardOptions): ActionCapabilities {
  const guarded: ActionCapabilities = { ...caps };

  if (caps.llm) {
    const model = llmModelLabel(caps.llm) ?? "unlabelled";
    guarded.llm = guard("LLM", (_prompt: string, _options?: LLMOptions) => ({ model }), caps.llm, opts);
  }

  if (caps.shell) {
    guarded.shell = guard("Bash", shellGateInput, caps.shell, opts);
  }
  if (caps.fetch) {
    guarded.fetch = guard(
      "Fetch",
      (input: Parameters<typeof fetch>[0]) => ({ url: typeof input === "string" ? input : String(input) }),
      caps.fetch,
      opts,
    ) as typeof fetch;
  }
  if (caps.writeFile) {
    guarded.writeFile = guard("Write", (path: string, content: string) => ({ path, content }), caps.writeFile, opts);
  }
  if (caps.readFile) {
    guarded.readFile = guard("Read", (path: string) => ({ path }), caps.readFile, opts);
  }

  return guarded;
}

export { PolicyDenial };
