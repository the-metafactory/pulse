/**
 * Chat models — the model side of a research step.
 *
 * A `ChatModel` is one chat-completions endpoint with tool calling. The host
 * builds its models and hands them to the step runner by name
 * (`StepRunnerOptions.models`); a pipeline names the model it wants, never an
 * endpoint or a key. `OpenAICompatibleChatModel` speaks the OpenAI
 * `/chat/completions` wire format that most gateways (LiteLLM, vLLM, Ollama's
 * OpenAI endpoint) serve.
 *
 * The key comes from a host-named environment variable, read at call time.
 * There is no fallback name: a model configured without its variable fails
 * as unavailable, it never borrows a key meant for something else.
 */

// ---------------------------------------------------------------------------
// Wire types — the subset of the OpenAI chat format a research step uses
// ---------------------------------------------------------------------------

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Omitted (not an empty array) when the model must answer without tools. */
  tools?: ChatTool[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ChatToolCall[];
  finishReason?: string;
  usage?: { input: number; output: number };
  /** Reasoning text some gateways return beside the answer (not sent back). */
  reasoning?: string;
}

export interface ChatModel {
  /** Short label for traces and errors (never the key or a full URL). */
  readonly label: string;
  complete(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The model could not be reached or refused for a transient reason: network
 * failure, timeout, missing key, HTTP 408/425/429 or any 5xx. A host that
 * queues work for later (the laptop off VPN, a gateway down) catches this
 * class and retries; anything else is a real failure.
 *
 * The message carries the status only. What the gateway said (`detail`,
 * redacted, clipped) may echo the request's content, so it stays off the
 * message and out of anything forwarded to a chat surface.
 */
export class ModelUnavailableError extends Error {
  constructor(
    public readonly model: string,
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(`model ${model} unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

/** The model answered with a non-transient error (HTTP 4xx, malformed body). `detail` as for ModelUnavailableError. */
export class ModelError extends Error {
  constructor(
    public readonly model: string,
    message: string,
    public readonly detail?: string,
  ) {
    super(`model ${model}: ${message}`);
    this.name = "ModelError";
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

export interface OpenAICompatibleConfig {
  /** Base URL up to and including the version segment, e.g. `https://host/v1`. */
  baseUrl: string;
  /** Model name or gateway alias sent as `model`. */
  model: string;
  /** Name of the environment variable holding the bearer key. Required, no default. */
  apiKeyEnv: string;
  /** Environment to read the key from (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Label for traces and errors (default: the model name). */
  label?: string;
  /** Per-request timeout in ms (default: 300000). */
  timeoutMs?: number;
  /** Defaults applied when a request leaves them unset. */
  temperature?: number;
  maxTokens?: number;
  /** Injected fetch, for tests. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** Transient below 500; every 5xx is transient too (gateway codes such as 520–524 included). */
const TRANSIENT_STATUS = new Set([408, 425, 429]);

export class OpenAICompatibleChatModel implements ChatModel {
  readonly label: string;
  private readonly config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.baseUrl) throw new Error("OpenAICompatibleChatModel: baseUrl is required");
    if (!config.model) throw new Error("OpenAICompatibleChatModel: model is required");
    if (!config.apiKeyEnv) throw new Error("OpenAICompatibleChatModel: apiKeyEnv is required");
    this.config = config;
    this.label = config.label ?? config.model;
  }

  async complete(request: ChatRequest, options: { signal?: AbortSignal } = {}): Promise<ChatResponse> {
    const env = this.config.env ?? process.env;
    const key = env[this.config.apiKeyEnv];
    if (!key) {
      throw new ModelUnavailableError(this.label, `no key in ${this.config.apiKeyEnv}`);
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      stream: false,
    };
    const temperature = request.temperature ?? this.config.temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    // A write turn sends no tools at all: some gateways answer
    // `tool_choice: "none"` with an empty message.
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      const reason = timeout.aborted ? "timeout" : err instanceof Error ? err.name : "network error";
      throw new ModelUnavailableError(this.label, this.redact(reason, key));
    }

    if (!res.ok) {
      // An unreadable error body leaves the status alone to report.
      const detail = this.redact((await res.text().catch(() => "")).slice(0, 300), key) || undefined;
      if (res.status >= 500 || TRANSIENT_STATUS.has(res.status)) {
        throw new ModelUnavailableError(this.label, `HTTP ${res.status}`, detail);
      }
      throw new ModelError(this.label, `HTTP ${res.status}`, detail);
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err) {
      // The body is read under the same signals as the request.
      if (options.signal?.aborted) throw err;
      if (timeout.aborted) throw new ModelUnavailableError(this.label, "timeout");
      // A 200 with a non-JSON body is a gateway fault, not a model answer.
      throw new ModelError(this.label, "response body is not JSON");
    }
    const choice = data?.choices?.[0];
    if (!choice || typeof choice !== "object") {
      throw new ModelError(this.label, "response has no choices");
    }
    const msg = choice.message ?? {};
    const toolCalls: ChatToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls
          .filter((c: any) => c && typeof c.function?.name === "string")
          .map((c: any, i: number) => ({
            id: typeof c.id === "string" && c.id ? c.id : `call_${i}`,
            type: "function" as const,
            function: {
              name: c.function.name,
              arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
            },
          }))
      : [];
    return {
      content: typeof msg.content === "string" ? msg.content : null,
      toolCalls,
      finishReason: choice.finish_reason ?? undefined,
      usage: data.usage
        ? { input: Number(data.usage.prompt_tokens ?? 0), output: Number(data.usage.completion_tokens ?? 0) }
        : undefined,
      reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined,
    };
  }

  /** Strip the key from any text that might reach an error message. */
  private redact(text: string, key: string): string {
    return key ? text.split(key).join("[redacted]") : text;
  }
}
