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
export async function createLocalCapabilities(
  required: CapabilityName[] = []
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
        capabilities.shell = createLocalShell();
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

  // Resolve claude to an absolute path. PULSE_CLAUDE_BIN wins — it lets a host
  // with a minimal PATH (e.g. a launchd daemon) point at the binary explicitly
  // instead of relying on `which`. Otherwise fall back to `which claude`.
  let claudePath = process.env.PULSE_CLAUDE_BIN?.trim();
  if (!claudePath) {
    const whichProc = Bun.spawnSync(["which", "claude"], { stdout: "pipe" });
    claudePath = whichProc.stdout.toString().trim();
    if (!claudePath || whichProc.exitCode !== 0) {
      log(`stage1 skipped: PULSE_CLAUDE_BIN unset and \`which claude\` failed (exit=${whichProc.exitCode})`);
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
  // Use the Claude Code SUBSCRIPTION (OAuth) for `claude -p`, never an inherited
  // ANTHROPIC_API_KEY. A key present in the env takes precedence inside the CLI,
  // and a stale/invalid one makes claude -p fail with "Invalid API key" — which
  // would then force the costly (and, with a bad key, also-failing) API
  // fallback. Stripping it keeps this a zero-marginal-cost subscription call,
  // the whole reason stage 1 prefers claude -p over the stage-3 API path.
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

    // A CC result with is_error (invalid key, usage limit, refusal) exits 0 but
    // its `result` is an error string, not a model answer. Treat it as a stage-1
    // miss so the caller falls back — never surface "Invalid API key" as LLM
    // output (which would poison the composer).
    try {
      const wrapper = JSON.parse(rawStdout) as { is_error?: boolean; result?: unknown };
      if (wrapper?.is_error === true) {
        log(`stage1 is_error: ${String(wrapper.result).slice(0, 200)}`);
        return null;
      }
    } catch (_err) {
      // Not a JSON wrapper (older CC plain-text output) — fall through to extract.
    }

    // Extract from CC JSON wrapper: {"type":"result","result":"<content>"}
    const text = extractClaudeOutput(rawStdout);

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

/** Extract text content from claude --output-format json wrapper */
function extractClaudeOutput(raw: string): string {
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper.type === "result" && typeof wrapper.result === "string") {
      return wrapper.result;
    }
    return raw;
  } catch (_err) {
    // Not a JSON wrapper — return raw text (e.g., plain text from older CC versions)
    return raw.trim();
  }
}

/**
 * Local shell provider using Bun's shell.
 */
function createLocalShell(): (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }> {
  return async (cmd: string) => {
    const proc = Bun.spawn(["sh", "-c", cmd], {
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
