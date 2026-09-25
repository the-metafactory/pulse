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
   `tool` message. The calls of one round run concurrently, at most four at
   a time; their results go back in the order the model made them. A round
   runs at most 16 calls; any beyond that are answered with an error text.
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
   whether the model or a tool is still working. The step's signal kills a
   tool's running `shell` child and aborts its `fetch` calls (actions also
   see it as `ctx.signal`). The kill reaches the direct child, which is
   prompt for the argv form research tools are held to; whatever an action
   does without those capabilities is left to finish, its result dropped.
   Calls still queued never start. If the model had not answered yet, the
   step fails with `ResearchUnavailable` (queue it); if a tool was still
   running, with a plain timeout. A step aborted from outside (a failing
   `parallel` sibling) reports "aborted".

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
- **Schema check.** Before the action runs, the model's arguments are checked
  against these keywords of the schema it was shown: `type`, `enum`,
  `minimum` / `maximum`, `minLength` / `maxLength`, `pattern`,
  `minItems` / `maxItems`, and `items`, `properties` and `required` in
  nested schemas. A nested object with `properties` may not carry other keys
  unless `additionalProperties` allows them. Other keywords (`format`,
  `uniqueItems`, …) are shown to the model but not checked; the action checks
  those itself.
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
throws `ModelUnavailableError` for a missing key, network failure, timeout
(while connecting or while the body arrives) and HTTP 408/425/429 or any 5xx,
and `ModelError` for other 4xx or a malformed body. An error's message
carries the status only; what the gateway answered goes on `detail`
(redacted, clipped), since it may echo the request — a research step writes it
to the transcript, never into an event. The key never appears in either. Any
object with a `complete()` method matching `ChatModel` works in its place.

### Degrading per item

A research step inside `map` should run with `onError: collect`. With the
default `stop`, the first unreachable model call stops the map and later
items never get their deterministic work. With `collect`, every item runs
its plain actions, and an item whose research could not reach the model is
collected as `{ _error: true, unavailable: true, index, item, error, partial }`.
`partial` is the item's payload as it stood when the research step started:
the output of the steps before it. Steps after the research step did not run
for that item. The host delivers `partial`, queues the research, and treats
any `_error` without `unavailable` as a real failure. With `stop`,
`PipelineResult.cause` is the `MapItemFailure` and its `original` holds the
`ResearchUnavailable`.

Within one `runPipeline` run, once a model call gets no answer at all (no
key, network failure, the model's own `timeoutMs`), every later research
step on it fails at once
with `ResearchUnavailable` (its message ends "earlier in this run") instead
of calling the model again. That includes a `retry:` around the step: the
run treats the model as absent, and the host queues the work. A 429 or 5xx
is an answer from the gateway and marks nothing; the next step calls again.
Neither does the step's `timeout_ms` firing while the model works: a slow
generation looks the same as a dead link, so that item is queued and the
next one tries.
A network that drops packets (off VPN, say) does not refuse the connection,
so the first call waits out `timeoutMs` (default 300 s, since long
generations take minutes); later calls in the run do not. With map `concurrency` above 1, the items already
in flight when the first call gives up have each called the model and each
wait too; only items that start after it fail at once.

## Transcript

With `StepRunnerOptions.transcriptDir` set, each research run writes
`research-<name>-<timestamp>-<id>.jsonl` there. The dir is set to 0700,
whether the step creates it or the host reuses one; the file is 0600. It holds a
`start` line, one `model` line per model turn (content, tool calls, usage),
one `tool` line per call (raw arguments, the input after bind, the result,
clipped to ten times `result_chars` with its full length in `result_length`),
a `model_error` line with the gateway's `detail` when a model call fails,
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
- Sovereignty. An `agent:` step declares `sovereignty` (e.g. `model_class:
  local-only`); a research step does not yet. It sends the payload and tool
  results to whichever model the host injected under that name, so today the
  host alone decides where that data may go. UNRESOLVED: a `sovereignty`
  field checked against a host-declared class per model.
