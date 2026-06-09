# Federated Build Journal — metafactory builds metafactory, in public

Two principals' agents co-author one public artifact. Jens-Christian's agent
drafts the week's build narrative from raw repo activity; Andreas' agent
answers **across the federation boundary** with his side's perspective; a human
gates it; pulse publishes it to Discord and the public build log on
[stack.meta-factory.ai](https://stack.meta-factory.ai/build-log/).

```
repo activity ──► agent: draft ─────► agent: perspective ──► gate ──► A_FORMAT_JOURNAL ──► A_POST_DISCORD
(git log, D)      jc's agent          andreas' agent          editor   merge + provenance   └► A_WRITE_BUILDLOG
                  local.jc.default    federated.andreas.      verdict
                  .tasks.*            meta-factory.tasks.*
```

The federation moment: the `perspective` envelope publishes on
`federated.andreas.meta-factory.tasks.ecosystem.perspective` and the answer
returns on `federated.jc.default.dispatch.task.*` — `local.` never crosses the
principal boundary (cortex CONTEXT.md). The provider enforces it: a federated
task cannot carry `classification: local`, and `max_hop` defaults to 1.

## Run it

```bash
# Offline: in-memory bus, simulated agents, canned answers, Discord dry-run
bun examples/build-journal/run-journal.ts

# Real model (claude CLI) writes both contributions
bun examples/build-journal/run-journal.ts --llm

# Real NATS bus — watch the federation with: nats sub 'federated.>'
bun examples/build-journal/run-journal.ts --live --llm

# Actually post to the public Discord (default: dry-run prints the message)
bun examples/build-journal/run-journal.ts --llm --post

# Type the editor verdict yourself / longer period
bun examples/build-journal/run-journal.ts --interactive --days 14
```

`--no-fleet` drops the simulator — for when Andreas' stack pubkey lands and
his real fleet claims `ecosystem.perspective` over the leaf node.

## Publishing

- **Discord** — via the cortex discord CLI (`~/bin/discord`), channel from
  `DISCORD_CHANNEL` (default `general`). Posting is opt-in (`--post`); the
  default dry-run prints exactly what would go out.
- **Build log** — writes `build-log/{date}-build-journal.html` plus a
  regenerated index into `~/work/mf/myelin-cortex-site` (same stylesheet and
  markup as the site's blog). `entries.json` is the manifest. Deploy stays a
  human step: preview, then ship the site with wrangler.

Every entry carries provenance: which agent drafted, which agent answered
over federation, which gate approved, which pipeline assembled.

## Until federation is live

`fleet-sim.ts` stands in for both fleets — Sage on the local subjects, an
andreas-agent on the federated ones, speaking the exact subject grammar and
lifecycle the real stacks speak. Prerequisites for retiring it:

1. Andreas' stack pubkey in the cortex `policy.federated` peers block
2. Leaf-node connection up (`nats-leaf-metafactory`)
3. His fleet announcing an `ecosystem.perspective` capability
