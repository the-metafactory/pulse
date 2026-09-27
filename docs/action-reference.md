# Action Reference

Actions are the atomic building blocks of pulse pipelines. Each action does one thing, declares what it needs, and passes data forward.

## Anatomy of an action

```
A_MY_ACTION/
  action.json   # Manifest: name, I/O schema, required capabilities
  action.ts     # Implementation: execute(input, ctx) → output
```

## action.json fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique identifier, `A_` prefix by convention |
| `version` | Yes | Semver string |
| `description` | Yes | What this action does |
| `input` | Yes | Input field declarations: `{ fieldName: { type, required? } }` |
| `output` | Yes | Output field declarations: `{ fieldName: { type } }` |
| `requires` | No | Capabilities needed: `["llm", "fetch", "shell", "readFile", "writeFile", "kv"]` |
| `tags` | No | Categorization tags |
| `author` | No | `{ name, url? }` |
| `license` | No | License identifier |
| `deployment` | No | Cloud hints: `{ timeout?, memory?, secrets? }` |

## Capabilities

Actions declare dependencies — they never import them. The runtime injects implementations based on `requires`.

### llm

```typescript
const result = await ctx.capabilities.llm!(prompt, {
  tier: "fast",          // "fast" (Haiku) | "standard" (Sonnet) | "smart" (Opus)
  system: "You are...",  // System prompt
  json: true,            // Parse response as JSON
  maxTokens: 1024,       // Max output tokens
});
// result.text: string
// result.json: unknown (if json: true)
// result.usage?: { input: number, output: number }
```

Which model answers is the host's choice, not the action's:

- **Injected model.** A host that sets `llmModel` (a `ChatModel`, e.g. `OpenAICompatibleChatModel`) on `runAction`, the step runner or `createLocalCapabilities` gets that model and nothing else. `system` becomes the system message, `maxTokens` the request's; `tier` is ignored. An answer without text throws `ModelError`; `ModelUnavailableError` reaches the action as thrown.
- **Fallback chain.** Without `llmModel`: `claude -p`, then PAI Inference, then `ANTHROPIC_API_KEY` from the environment or a nearby `.env`, with `tier` picking Haiku, Sonnet or Opus.

Under a policy, `llm` is the gate tool `LLM`, matched on `model`: the injected model's label, or `fallback` for the chain. The prompt is never part of the gate input. A rule allowing one label, with default deny, pins an action to that model and refuses the chain:

```json
{ "version": 1, "default": "deny",
  "rules": [{ "tool": "LLM", "match": { "model": "^longctx$" }, "decision": "allow" }] }
```

### fetch

Standard `fetch` API — same as `globalThis.fetch`.

```typescript
const response = await ctx.capabilities.fetch!(url, { headers: {...} });
const data = await response.json();
```

### shell

Execute shell commands. Local only — not available on Cloudflare Workers.

```typescript
const result = await ctx.capabilities.shell!("gh pr list --json number,title");
// result.stdout: string
// result.stderr: string
// result.code: number (0 = success)
```

### readFile / writeFile

File system access. Local only.

```typescript
const content = await ctx.capabilities.readFile!("/path/to/file");
await ctx.capabilities.writeFile!("/path/to/output", content);
```

### kv

Key-value storage. In-memory locally, KV namespace binding on Workers.

```typescript
await ctx.capabilities.kv!.set("key", "value", 3600);  // TTL in seconds
const value = await ctx.capabilities.kv!.get("key");    // string | null
await ctx.capabilities.kv!.delete("key");
```

## The passthrough pattern

Every action follows the same shape:

```typescript
export default {
  async execute(input, ctx) {
    const { fieldINeed, anotherField, ...payload } = input;

    // Do your work using capabilities
    const result = doSomething(fieldINeed);

    // Return payload + your fields
    return { ...payload, myNewField: result };
  },
};
```

**Why this matters:** In a pipeline, actions run in sequence. Each action receives *everything* from all previous actions. By spreading `...payload`, you guarantee nothing is lost. The last action in a pipeline has access to every field produced by every preceding action.

## Input validation

Pulse validates `required` fields from `action.json` before calling `execute`. If a required field is missing, the action fails without running.

```json
"input": {
  "content": { "type": "string", "required": true },
  "maxLength": { "type": "number" }
}
```

`content` must be present. `maxLength` is optional.

## Error handling

Throw errors for failures. Pulse catches them and reports via the pipeline result:

```typescript
if (!ctx.capabilities.llm) throw new Error("LLM capability required");
```

For non-fatal failures (e.g., Discord posting), catch internally and set a status field:

```typescript
let posted = false;
try {
  await shell(`discord post "${message}"`);
  posted = true;
} catch {
  // Non-fatal — pipeline continues
}
return { ...payload, posted };
```

## Naming conventions

| Prefix | Meaning | Examples |
|---|---|---|
| `A_FETCH_*` | Fetches data from an external source | `A_FETCH_FEED`, `A_FETCH_REPOS` |
| `A_EXTRACT_*` | Extracts/transforms data | `A_EXTRACT_ARTICLE` |
| `A_CHECK_*` | Reads local state | `A_CHECK_BLUEPRINT` |
| `A_RATE` / `A_LABEL` | LLM evaluation/classification | `A_RATE`, `A_SUMMARIZE_DIGEST` |
| `A_FORMAT_*` | Formats output for a destination | `A_FORMAT_DISCORD` |
| `A_DELIVER` / `A_SEND_*` | Delivers to external system | `A_DELIVER`, `A_SEND_EMAIL` |
