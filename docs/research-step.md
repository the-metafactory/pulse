# Research step

A `research:` step lets a chat model gather what it needs through the
pipeline's own actions, then write an answer. The model picks tools and
arguments; the step runs every call. It exists for the case where a fixed
context is too thin and the model has to dig — a meeting prep that searches
mail, calendar history and notes for the people involved, say — while the
deterministic parts of the pipeline stay plain actions.

## Shape

```yaml
name: P_MEETING_PREP
actions:
  - A_GATHER_MEETING            # deterministic; puts `meeting` on the payload
  - research:
      name: prep
      model: local              # a key in StepRunnerOptions.models
      system: "You prepare meetings. Use the tools, then write the prep."
      prompt: "Prepare this meeting:\n{meeting}"
      tools: [A_MAIL_SEARCH, A_MAIL_READ, A_CALENDAR_HISTORY, A_NOTES_SEARCH]
      bind: { account: team, workspace: notes }
      max_rounds: 12
      write_prompt: "Research is over. Write the prep now."
      collect: prep
  - A_DELIVER_PREP
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | required | Events, transcript file name, default collect field |
| `model` | required | Key into `StepRunnerOptions.models` |
| `prompt` | required | User message; `{field}` / `{a.b}` render from the payload |
| `system` | — | System message; same rendering |
| `tools` | required | Action names offered as tools; each must be `effect: read` |
| `bind` | `{}` | Input fields pinned for every tool that declares them |
| `max_rounds` | 12 | Tool rounds before the model must write |
| `write_prompt` | generic | Message that ends research |
| `empty_retries` | 2 | Extra write turns when the answer is empty |
| `result_chars` | 4000 | Characters of each tool result the model sees |
| `max_tokens`, `temperature` | model's | Per-request settings |
| `timeout_ms` | — | Whole-step timeout; covers model calls and tool runs |
| `collect` | `research_<name>` | Payload field for the answer |

## The loop

1. Each round sends the conversation with the tools. Every tool call runs
   through `runAction` with the model's arguments and the step's `bind`; the
   result (the action's declared output fields, clipped) goes back as a
   `tool` message. The calls of one round run concurrently; their results
   go back in the order the model made them.
2. A reply without tool calls is the answer. After `max_rounds` the step adds
   `write_prompt` and sends the conversation **without a `tools` field** —
   some gateways answer `tool_choice: "none"` with an empty message.
3. An empty answer earns up to `empty_retries` more write turns, then fails
   the step.
4. A repeated call (same tool, same argument string) is answered with a
   pointer to the earlier result instead of running again. Unknown tools,
   malformed arguments and arguments outside the schema the model was shown
   are answered with an error text, not run.
5. `timeout_ms` bounds the whole step. It ends a round the moment it fires,
   whether the model or a tool is still working; a tool that is still running
   is left to finish on its own, and its result is dropped.

## What limits a manipulated model

Tools read untrusted text (mail bodies, tickets), so a tool result can try to
instruct the model. Pulse has no sandbox — an action is code in the host
process — so the defence is to keep effects out of the model's reach and to
narrow what its arguments can do:

- **`effect: read` only.** `action.json` declares `effect: read | write`. A
  research step naming a tool that is not `read` (absent counts as not read)
  fails the pipeline in a preflight before its first step runs; a step
  driven without `runPipeline` checks its tools itself. Sending, posting and
  drafting never become tools.
- **`bind:` pins.** A bound field leaves the schema the model sees and is
  forced onto every call; model arguments outside the declared fields are
  dropped. Actions carry no pins of their own, so one action serves several
  pipelines with different pins. A bind key that no tool declares is a
  preflight error, since a typo would silently unpin the field.
- **Schema check.** The model's arguments are checked against the schema it
  was shown — `type`, `minimum` / `maximum`, `minLength` / `maxLength`,
  `enum`, `maxItems` and item types — before the action runs.
- **Argv shell.** `shell` takes an argv array and spawns the program with no
  `sh -c`, so a model-chosen query cannot become shell syntax. Tools run
  inside a research step get a shell that refuses the string form.
- **Host policy.** When the host sets `StepRunnerOptions.policy`, every tool
  call's shell, fetch and file access passes the enforcement gate. A shell
  call's gate input carries `form` (`argv` | `string`), `program` (argv[0]),
  `argv` and a shell-quoted `command`, so a policy can pin binaries with an
  anchored `program` regex and deny `form: string` outright. Rules written
  against `command` keep working.

What this does not cover: `effect: read` is the action author's claim, and
a read action still carries the model's arguments to wherever it reads from.
A search tool that fetches a URL built from the model's query can send what
the model has read to that host; an argv element the model chose can be a
flag (`--output=…`) rather than a search term. An action that takes a
model-chosen value treats it as untrusted: an `enum` or tight bounds in the
manifest, a `--` before positional arguments, a fixed host. The host policy
is the second line (pin programs and URLs); without one, the actions are the
only line.

## Models

The host builds its models and passes them by name:

```ts
import { OpenAICompatibleChatModel, runPipelineFromYaml, ResearchUnavailable } from "pulse";

const models = {
  local: new OpenAICompatibleChatModel({
    baseUrl: process.env.MY_GATEWAY_URL!,   // up to /v1
    model: "my-alias",
    apiKeyEnv: "MYPACK_GATEWAY_KEY",        // read at call time; no fallback name
  }),
};
const result = await runPipelineFromYaml(path, input, { models, transcriptDir, policy });
if (!result.success && result.cause instanceof ResearchUnavailable) {
  // the gateway is unreachable: deliver what the deterministic steps produced,
  // queue the research for later
}
```

`OpenAICompatibleChatModel` speaks `POST {baseUrl}/chat/completions`. It
throws `ModelUnavailableError` for a missing key, network failure, timeout and
HTTP 408/425/429/5xx, and `ModelError` for other 4xx or a malformed body. The
key never appears in an error message. Any object with a `complete()` method
matching `ChatModel` works in its place.

### Degrading per item

A research step inside `map` should run with `onError: collect`. With the
default `stop`, the first unreachable model call stops the map and later
items never get their deterministic work. With `collect`, every item runs
its plain actions, and an item whose research could not reach the model is
collected as `{ _error: true, unavailable: true, index, item, error }` — the
host queues those and treats any `_error` without `unavailable` as a real
failure. With `stop`, `PipelineResult.cause` is the `MapItemFailure` and its
`original` holds the `ResearchUnavailable`.

A network that drops packets (off VPN, say) does not refuse the connection;
each call waits out `timeoutMs` (default 300 s, since long generations take
minutes). A host that expects the model to be absent often should check
reachability once per run with a short request and skip the research steps
when it fails, rather than lower the timeout for every call.

## Transcript

With `StepRunnerOptions.transcriptDir` set, each research run writes
`research-<name>-<timestamp>-<id>.jsonl` there. The dir is set to 0700,
whether the step creates it or the host reuses one; the file is 0600. It holds a
`start` line, one `model` line per model turn (content, tool calls, usage),
one `tool` line per call (raw arguments, the input after bind, the result),
and an `end` line with the stats, on success and on failure alike. Without
`transcriptDir` nothing is written. A transcript is not a Trace (the
miner-owned execution record); it is a debugging log of one research run.
`onResearchEvent` carries names, counts and sizes only, never arguments or
results, so it is safe to forward to a chat surface.

## Action manifest

```json
{
  "name": "A_MAIL_SEARCH",
  "version": "1.0.0",
  "description": "Full-text search over a mailbox. Returns id, date, from, subject.",
  "effect": "read",
  "requires": ["shell"],
  "input": {
    "query":   { "type": "string", "required": true, "description": "words to match" },
    "account": { "type": "string", "required": true },
    "limit":   { "type": "integer", "default": 10, "maximum": 25 }
  },
  "output": { "text": { "type": "string" } }
}
```

The description is what the model reads to choose the tool; field
descriptions, enums and defaults go into the tool's JSON Schema as written.
`runAction` fills defaults and checks enums for every caller, so the same
action runs as a plain pipeline step with no model involved. Type and bounds
are checked for a model's arguments only; a plain step's input comes from the
pipeline author.

## Not here

- Cortex tool execution: when a cortex agent can run a restricted tool loop,
  an `agent:` step may take over the loop. The tool definition this step
  builds (manifest JSON Schema plus `effect`) is the shape to hand it.
- A policy generated from a pack's declared capabilities.
- Streaming, and a `write` path of any kind — effects go
  through plain actions, `gate:` or `governed:`.
