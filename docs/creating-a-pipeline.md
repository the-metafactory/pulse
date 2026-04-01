# Creating a Pipeline Package

A pipeline package is a set of actions chained together with the passthrough pipe model, packaged for installation via arc. This guide walks through creating one from scratch.

## Structure

A pipeline package is a git repo with this layout:

```
my-pipeline/
  arc-manifest.yaml    # Package metadata for arc
  pipeline.yaml        # Pipeline definition
  types.ts             # ActionContext type (for TypeScript)
  run-pipeline.ts      # CLI runner script
  A_FIRST_STEP/        # Each action is a directory
    action.json        # Action manifest (name, I/O, capabilities)
    action.ts          # Action implementation
  A_SECOND_STEP/
    action.json
    action.ts
  A_THIRD_STEP/
    action.json
    action.ts
```

## Step 1: Define the pipeline

Start with `pipeline.yaml`. This declares the action chain:

```yaml
name: P_MY_PIPELINE
description: "What this pipeline does in one line"
actions:
  - A_FIRST_STEP
  - A_SECOND_STEP
  - A_THIRD_STEP
```

Actions run in order. Each one's output becomes the next one's input. Data accumulates — nothing is lost.

## Step 2: Create actions

Each action is a directory with two files.

### action.json — the manifest

Declares what the action needs and produces:

```json
{
  "name": "A_FIRST_STEP",
  "version": "1.0.0",
  "description": "What this action does",
  "input": {
    "url": { "type": "string", "required": true },
    "limit": { "type": "number" }
  },
  "output": {
    "items": { "type": "array" },
    "fetchedAt": { "type": "string" }
  },
  "requires": ["fetch"],
  "tags": ["fetch", "rss"]
}
```

**`requires`** declares which capabilities the action needs from the runtime:

| Capability | What it provides | Runs locally? | Runs on Workers? |
|---|---|---|---|
| `fetch` | HTTP fetch | Yes | Yes |
| `llm` | LLM inference (Anthropic API) | Yes | Yes |
| `shell` | Shell command execution | Yes | No |
| `readFile` | Read files from disk | Yes | No |
| `writeFile` | Write files to disk | Yes | No |
| `kv` | Key-value storage | Yes (in-memory) | Yes (KV binding) |

Actions that only need `fetch` and `llm` can run anywhere. Actions using `shell` or file I/O are local-only.

### action.ts — the implementation

The implementation follows the **passthrough pattern**:

```typescript
import type { ActionContext } from "../types";

interface Input {
  url: string;
  limit?: number;
  [key: string]: unknown;  // ← Accept upstream fields
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    // 1. Destructure what you need, spread the rest
    const { url, limit = 10, ...upstream } = input;

    // 2. Use capabilities (never import dependencies directly)
    const response = await ctx.capabilities.fetch!(url);
    const data = await response.json();

    // 3. Return upstream + your new fields
    return {
      ...upstream,        // Everything from previous actions
      items: data.items,  // Your contribution
      fetchedAt: new Date().toISOString(),
    };
  },
};
```

**Three rules:**
1. **Destructure + spread**: `const { myField, ...upstream } = input` — take what you need, keep the rest
2. **Use capabilities**: `ctx.capabilities.llm!(...)` — never `import anthropic` or `import { $ } from "bun"`
3. **Return merged**: `{ ...upstream, ...myFields }` — pass everything forward

### The passthrough pattern in practice

Given a 3-action pipeline, data accumulates:

```
Input:        { url: "https://..." }

A_FETCH:      { url: "https://...", items: [...], fetchedAt: "..." }

A_PROCESS:    { url: "https://...", items: [...], fetchedAt: "...",
                processed: [...], count: 42 }

A_FORMAT:     { url: "https://...", items: [...], fetchedAt: "...",
                processed: [...], count: 42,
                digest: "# Report\n...", formattedAt: "..." }
```

The last action has access to every field from every preceding action.

## Step 3: Add the types file

Create `types.ts` so your actions have TypeScript support without depending on pulse's source tree:

```typescript
export interface ActionContext {
  capabilities: {
    llm?: (prompt: string, options?: {
      tier?: string; system?: string; json?: boolean; maxTokens?: number
    }) => Promise<{ text: string; json?: unknown }>;
    fetch?: typeof globalThis.fetch;
    shell?: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
    readFile?: (path: string) => Promise<string>;
    writeFile?: (path: string, content: string) => Promise<void>;
    kv?: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string, ttl?: number) => Promise<void>;
    };
  };
  env: { mode: "local" | "cloud" };
}
```

## Step 4: Create the runner script

`run-pipeline.ts` is the CLI entry point:

```typescript
#!/usr/bin/env bun

// Resolve pulse from common locations
const pulsePaths = [
  `${import.meta.dir}/../pulse/src/lib/pipeline.ts`,
  `${process.env.HOME}/.config/arc/pkg/repos/pulse/src/lib/pipeline.ts`,
  `${process.env.HOME}/work/mf/pulse/src/lib/pipeline.ts`,
];
let pulseMod: any;
for (const p of pulsePaths) {
  try { pulseMod = await import(p); break; } catch {}
}
if (!pulseMod) throw new Error("Pulse not found. Install via: arc install pulse");
const { runPipelineFromYaml } = pulseMod;

import { join } from "path";
const PIPELINE_YAML = join(import.meta.dir, "pipeline.yaml");

const result = await runPipelineFromYaml(
  PIPELINE_YAML,
  { /* initial input */ },
  {}  // options — actionDirs auto-resolved from pipeline.yaml location
);

if (result.success) {
  console.log(result.output);
} else {
  console.error("Pipeline failed:", result.steps.find(s => !s.success)?.error);
  process.exit(1);
}
```

## Step 5: Write the arc manifest

`arc-manifest.yaml` makes it installable:

```yaml
schema: arc/v1
name: my-pipeline
type: pipeline
tier: community
version: 0.1.0
description: "What this pipeline does"
author:
  name: Your Name
  github: yourgithub
license: MIT

depends_on:
  tools:
    - bun
  packages:
    - name: pulse
      repo: https://github.com/the-metafactory/pulse
      version: ">=0.3.0"

provides:
  cli:
    - name: my-pipeline
      command: bun run-pipeline.ts
      description: "Run the pipeline"
  pipeline:
    definition: pipeline.yaml
    actions: [A_FIRST_STEP, A_SECOND_STEP, A_THIRD_STEP]

capabilities:
  network:
    - domain: api.anthropic.com
      reason: LLM inference
  secrets:
    - ANTHROPIC_API_KEY
```

## Step 6: Test locally

```bash
# Run directly
bun run-pipeline.ts

# Or via pulse
cd my-pipeline
bun ~/work/mf/pulse/src/cli.ts validate pipeline.yaml
```

## Step 7: Publish

```bash
git init && git add -A && git commit -m "feat: initial pipeline"
gh repo create the-metafactory/my-pipeline --private --source . --push
```

Others install with:
```bash
arc install https://github.com/the-metafactory/my-pipeline
my-pipeline  # Run it
```

## Using LLM actions

When an action needs LLM, declare `"requires": ["llm"]` and use `ctx.capabilities.llm`:

```typescript
export default {
  async execute(input: Input, ctx: ActionContext) {
    const { content, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    const result = await llm(content, {
      tier: "fast",        // fast (Haiku), standard (Sonnet), smart (Opus)
      system: "You are a concise summarizer.",
      json: true,          // Expect JSON response
      maxTokens: 1024,
    });

    // result.text = raw text, result.json = parsed if json: true
    return { ...upstream, summary: result.text };
  },
};
```

The LLM capability reads `ANTHROPIC_API_KEY` from environment or `~/work/mf/.env`.

## Wrapping in a Flow

To add scheduling or source/destination routing, create `flow.yaml`:

```yaml
name: F_MY_FLOW
description: "Run pipeline on a schedule"
source:
  type: inline
destination:
  type: file
  path: ./output.json
  format: json
pipeline: ./pipeline.yaml
schedule:
  intervalSeconds: 21600
```

## Real examples

- [ecosystem-digest](https://github.com/the-metafactory/ecosystem-digest) — GitHub activity + blueprint status → LLM summary → Discord
- [handover-digest](https://github.com/the-metafactory/handover-digest) — Timezone handover between team members
- [rss-pipeline](../examples/rss-pipeline/) — RSS feed → extract → rate → recommend (bundled demo)
