/**
 * Capability providers for different runtimes.
 *
 * Local capabilities use Bun APIs directly.
 * Cloud capabilities would use Cloudflare Worker bindings.
 *
 * Based on Daniel Miessler's PAI capability injection pattern.
 */

import type { ActionCapabilities, CapabilityName, LLMOptions, LLMResponse } from "../types/action";

/**
 * Create capability providers for local (Bun) execution.
 *
 * Only creates capabilities that the action declared in its manifest.
 * Actions never get capabilities they didn't ask for.
 */
export interface LocalCapabilityOptions {
  /** Shell refuses the string (`sh -c`) form and runs argv arrays only. */
  shellArgvOnly?: boolean;
}

export async function createLocalCapabilities(
  required: CapabilityName[] = [],
  options: LocalCapabilityOptions = {},
): Promise<ActionCapabilities> {
  const capabilities: ActionCapabilities = {};

  for (const cap of required) {
    switch (cap) {
      case "llm":
        capabilities.llm = createLocalLLM();
        break;
      case "fetch":
        capabilities.fetch = globalThis.fetch;
        break;
      case "shell":
        capabilities.shell = createLocalShell(options.shellArgvOnly === true);
        break;
      case "readFile":
        capabilities.readFile = async (path: string) => Bun.file(path).text();
        break;
      case "writeFile":
        capabilities.writeFile = async (path: string, content: string) => {
          await Bun.write(path, content);
        };
        break;
      case "kv":
        capabilities.kv = createLocalKV();
        break;
    }
  }

  return capabilities;
}

/**
 * Local LLM provider.
 *
 * Tries PAI's Inference tool first (if available), falls back to
 * Priority: claude -p (CC subscription, no marginal cost) → PAI Inference → Anthropic API.
 */
function createLocalLLM(): (prompt: string, options?: LLMOptions) => Promise<LLMResponse> {
  return async (prompt: string, options?: LLMOptions): Promise<LLMResponse> => {
    const debug = process.env.PULSE_LLM_DEBUG === "1";
    const log = (msg: string) => { if (debug) console.error(`[pulse:llm] ${msg}`); };

    // 1. Try claude -p (CC subscription — no per-token cost)
    const ccResult = await tryClaudeCLI(prompt, options);
    if (ccResult) return ccResult;

    // 2. Try PAI Inference tool
    const inferPath = `${process.env.HOME}/.claude/PAI/Tools/Inference.ts`;
    try {
      const file = Bun.file(inferPath);
      if (!(await file.exists())) {
        log(`stage2 skipped: ${inferPath} not found`);
      } else {
        const { inference } = await import(inferPath);
        const tierMap = { fast: "fast", standard: "standard", smart: "smart" } as const;
        const result = await inference({
          userPrompt: prompt,
          systemPrompt: options?.system,
          level: tierMap[options?.tier || "fast"],
          expectJson: options?.json,
          maxTokens: options?.maxTokens,
        });
        if (result.success) {
          return { text: result.output || "", json: result.parsed, usage: result.usage };
        }
        log(`stage2 failed: ${result.error || "inference returned success=false"} (latency=${result.latencyMs}ms)`);
      }
    } catch (err) {
      log(`stage2 threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Fallback: direct Anthropic API
    let apiKey = process.env.ANTHROPIC_API_KEY;
    let apiKeySource = apiKey ? "env:ANTHROPIC_API_KEY" : "";
    if (!apiKey) {
      for (const envPath of [
        `${process.cwd()}/.env`,
        `${process.cwd()}/../.env`,
        `${process.env.HOME}/work/mf/.env`,
      ]) {
        try {
          const envFile = Bun.file(envPath);
          if (await envFile.exists()) {
            const content = await envFile.text();
            const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
            if (match) { apiKey = match[1].trim(); apiKeySource = envPath; break; }
          }
        } catch (_err) {
          // .env unreadable or missing — try next candidate
        }
      }
    }

    if (!apiKey) {
      throw new Error("LLM capability requires claude CLI, PAI Inference tool, or ANTHROPIC_API_KEY");
    }

    log(`stage3: using API key from ${apiKeySource} (prefix=${apiKey.slice(0, 12)}…)`);

    const modelMap = { fast: "claude-haiku-4-5-20251001", standard: "claude-sonnet-4-6", smart: "claude-opus-4-6" } as const;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelMap[options?.tier || "fast"],
        max_tokens: options?.maxTokens || 1024,
        system: options?.system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} (key from ${apiKeySource})`);
    }

    const data = await response.json() as any;
    const text = data.content?.[0]?.text || "";

    let json: unknown;
    if (options?.json) {
      const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      try {
        json = JSON.parse(cleaned);
      } catch {
        json = undefined;
      }
    }

    return {
      text,
      json,
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined,
    };
  };
}

/** Max time to wait for claude -p response before killing the process */
const CLAUDE_CLI_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * Invoke claude -p for LLM calls using the CC subscription (no API cost).
 * Uses --output-format json for structured output extraction.
 * Returns null if claude CLI is not available.
 */
async function tryClaudeCLI(prompt: string, options?: LLMOptions): Promise<LLMResponse | null> {
  const modelMap = { fast: "haiku", standard: "sonnet", smart: "opus" } as const;
  const debug = process.env.PULSE_LLM_DEBUG === "1";
  const log = (msg: string) => { if (debug) console.error(`[pulse:llm] ${msg}`); };

  // Resolve claude to an ABSOLUTE path (no PATH-dependent invocation). An
  // operator may override via PULSE_CLAUDE_BIN — useful on a host with a minimal
  // PATH (e.g. a launchd daemon) — but it must itself be absolute; a relative
  // value would reintroduce the PATH dependency, so it's ignored with a warning
  // and we fall back to `which claude`.
  const override = process.env.PULSE_CLAUDE_BIN?.trim();
  let claudePath: string;
  if (override && override.startsWith("/")) {
    claudePath = override;
  } else {
    if (override) log(`stage1: ignoring non-absolute PULSE_CLAUDE_BIN="${override}" — falling back to \`which\``);
    const whichProc = Bun.spawnSync(["which", "claude"], { stdout: "pipe" });
    claudePath = whichProc.stdout.toString().trim();
    if (!claudePath || whichProc.exitCode !== 0) {
      log(`stage1 skipped: no absolute PULSE_CLAUDE_BIN and \`which claude\` failed (exit=${whichProc.exitCode})`);
      return null;
    }
  }

  const args = [
    claudePath, "-p",
    "--output-format", "json",
    "--model", modelMap[options?.tier || "fast"],
    "--setting-sources", "",  // Skip CLAUDE.md/hooks/PAI — pure LLM call, keeps OAuth auth
    "--disable-slash-commands",
    "--tools", "",  // Disable all tools — LLM-only call, no tool use needed
    "--no-session-persistence",
  ];
  if (options?.system) {
    args.push("--system-prompt", options.system);
  }
  args.push(prompt);

  // Clean env to avoid session interference.
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  // Remove ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the subprocess env.
  // Observed (Claude Code CLI, mid-2026, not a documented contract): when an
  // API key is present in the env the CLI uses it INSTEAD of its login state,
  // so a stale/invalid key makes `claude -p` return "Invalid API key" — which
  // then forces the (costly, and with a bad key also-failing) API fallback.
  // Stripping these lets the CLI use whatever non-key auth it already has — the
  // logged-in CC subscription on a normal install. (This does not itself verify
  // a login exists; if none does, `claude -p` fails and stage 1 simply misses.)
  delete cleanEnv.ANTHROPIC_API_KEY;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;

  const startedAt = Date.now();
  let timedOut = false;

  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
      // Force kill if SIGTERM doesn't work after 5s
      const forceKill = setTimeout(() => proc.kill(9), 5_000);
      proc.exited.then(() => clearTimeout(forceKill));
    }, CLAUDE_CLI_TIMEOUT_MS);

    const [rawStdout, rawStderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const elapsed = Date.now() - startedAt;
      const reason = timedOut ? `timeout after ${CLAUDE_CLI_TIMEOUT_MS}ms` : `exit=${exitCode}`;
      const stderrTail = rawStderr.slice(-1000).trim();
      log(`stage1 failed (${reason}, elapsed=${elapsed}ms, tier=${options?.tier || "fast"}, model=${modelMap[options?.tier || "fast"]})${stderrTail ? `\n  stderr: ${stderrTail}` : ""}`);
      return null;
    }

    // Extract from CC JSON wrapper: {"type":"result","result":"<content>"}.
    // A CC result with is_error (invalid key, usage limit, refusal) exits 0 but
    // its `result` is an error string, not a model answer — treat it as a
    // stage-1 miss so the caller falls back, never surfacing "Invalid API key"
    // as LLM output (which would poison the composer).
    const { text, isError } = extractClaudeOutput(rawStdout);
    if (isError) {
      log(`stage1 is_error: ${text.slice(0, 200)}`);
      return null;
    }

    let json: unknown;
    if (options?.json) {
      const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      try {
        json = JSON.parse(cleaned);
      } catch (_err) {
        // Response wasn't valid JSON despite json option — return text only
        json = undefined;
      }
    }

    return { text, json };
  } catch (err) {
    log(`stage1 spawn threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract content from a `claude --output-format json` wrapper in ONE parse,
 * returning both the text and whether the CLI flagged an error result
 * (`is_error: true` — invalid key, usage limit, refusal). Older plain-text CC
 * output (non-JSON) is returned as-is with isError=false.
 */
function extractClaudeOutput(raw: string): { text: string; isError: boolean } {
  try {
    const wrapper = JSON.parse(raw) as { type?: string; result?: unknown; is_error?: boolean };
    const isError = wrapper?.is_error === true;
    if (wrapper?.type === "result" && typeof wrapper.result === "string") {
      return { text: wrapper.result, isError };
    }
    return { text: raw, isError };
  } catch (_err) {
    // Not a JSON wrapper — return raw text (e.g., plain text from older CC versions)
    return { text: raw.trim(), isError: false };
  }
}

/**
 * Local shell provider. A string command runs through `sh -c`; an argv
 * array spawns argv[0] directly, so no argument is ever parsed by a shell.
 * With argvOnly the string form is refused — the promise rejects.
 */
export function createLocalShell(
  argvOnly = false,
): (cmd: string | string[]) => Promise<{ stdout: string; stderr: string; code: number }> {
  return async (cmd: string | string[]) => {
    let argv: string[];
    if (Array.isArray(cmd)) {
      if (cmd.length === 0 || cmd.some((a) => typeof a !== "string")) {
        throw new Error("shell: argv must be a non-empty array of strings");
      }
      argv = cmd;
    } else {
      if (argvOnly) {
        throw new Error("shell: the string form (sh -c) is refused here; pass an argv array");
      }
      argv = ["sh", "-c", cmd];
    }
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  };
}

/**
 * Local KV provider using an in-memory Map.
 * For persistent local KV, swap this for SQLite or file-backed storage.
 */
function createLocalKV() {
  const store = new Map<string, { value: string; expires?: number }>();

  return {
    get: async (key: string): Promise<string | null> => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expires && Date.now() > entry.expires) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key: string, value: string, ttl?: number): Promise<void> => {
      store.set(key, {
        value,
        expires: ttl ? Date.now() + ttl * 1000 : undefined,
      });
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };
}

/**
 * Create capability providers for Cloudflare Worker execution.
 *
 * Uses Worker bindings (AI, KV, R2) instead of local APIs.
 * The action code doesn't change — only the capability implementations differ.
 */
export async function createCloudCapabilities(
  required: CapabilityName[] = [],
  _env?: Record<string, unknown>
): Promise<ActionCapabilities> {
  const capabilities: ActionCapabilities = {};

  for (const cap of required) {
    switch (cap) {
      case "fetch":
        capabilities.fetch = globalThis.fetch;
        break;
      case "llm":
        // Cloud LLM would use Workers AI binding or API key from env
        capabilities.llm = createLocalLLM(); // Same for now; Workers can use API too
        break;
      case "kv":
        // In a real Worker, this would use env.KV_NAMESPACE binding
        capabilities.kv = createLocalKV(); // Placeholder
        break;
      // shell, readFile, writeFile not available in Workers
    }
  }

  return capabilities;
}
