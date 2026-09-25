/**
 * Research step types — a model researches through read-only actions.
 *
 * A `research:` step hands a chat model a declared set of pipeline actions
 * as tools, lets it call them for a bounded number of rounds, then asks it to
 * write its answer with no tools on offer. The step owns every tool call: the
 * model only picks the tool and its arguments.
 *
 * What limits a manipulated model (the model may read untrusted text through
 * its tools, so prompt injection is the threat model):
 *
 * - every tool must declare `effect: read`; the pipeline refuses to start
 *   otherwise (preflight), and a step driven without runPipeline checks itself
 * - `bind:` pins input fields; a bound field leaves the schema the model sees
 *   and its value is forced onto every call
 * - the model's arguments are checked against the schema it was shown
 * - tools run with an argv-only shell (no `sh -c`)
 * - when the host sets StepRunnerOptions.policy, it guards every tool call
 *
 * `effect: read` is the action author's claim, and a read action still sends
 * the model's arguments where it reads from (a query URL, a program's argv).
 * Keeping those arguments harmless is the action's job and the policy's.
 *
 * The chat model is injected by the host (StepRunnerOptions.models) and named
 * here, so no endpoint or key appears in a pipeline file.
 */

export interface ResearchStepSpec {
  /** Stable identifier (events, transcripts, default collect field). */
  name: string;
  /** Key into StepRunnerOptions.models. */
  model: string;
  /** User prompt; `{field}` / `{dotted.path}` placeholders render from the payload. */
  prompt: string;
  /** Optional system prompt; same placeholder rules. */
  system?: string;
  /** Action names offered to the model as tools. Each must declare `effect: read`. */
  tools: string[];
  /** Input fields pinned for every tool that declares them; hidden from the model. */
  bind?: Record<string, unknown>;
  /** Tool rounds before the model must write (default 12). */
  max_rounds?: number;
  /** The message that ends research and asks for the answer. */
  write_prompt?: string;
  /** Extra write turns when the answer comes back empty (default 2). */
  empty_retries?: number;
  /** Characters of each tool result the model sees (default 4000). */
  result_chars?: number;
  /** Per-request model settings. */
  max_tokens?: number;
  temperature?: number;
  /** Whole-step timeout in ms; covers model calls and tool runs alike. */
  timeout_ms?: number;
  /** Payload field for the answer (default `research_${name}`). */
  collect?: string;
}

/** Per-step statistics, recorded on the StepRecord. */
export interface ResearchStats {
  name: string;
  model: string;
  rounds: number;
  tool_calls: Record<string, number>;
  duplicates: number;
  empty_retries: number;
  tokens_in: number;
  tokens_out: number;
  answer_chars: number;
  /** Path of the JSONL transcript, when the host gave a transcript dir. */
  transcript?: string;
}

/**
 * Research lifecycle events. They carry names, counts and sizes only — never
 * arguments or results, which may hold the data the step researched. Those go
 * to the JSONL transcript in the host's transcript dir.
 */
export type ResearchEvent =
  | { type: "research.started"; name: string; model: string; tools: string[] }
  | { type: "research.round"; name: string; round: number; tool_calls: string[] }
  | { type: "research.completed"; name: string; stats: ResearchStats }
  | { type: "research.failed"; name: string; error: string; unavailable: boolean };
