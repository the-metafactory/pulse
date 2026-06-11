# A_NOTIFY_DISCORD — deliver pipeline output to Discord

A pipeline-facing action that posts a message (and optional file attachments)
to one of **our** Discord channels by shelling out to the cortex `discord`
CLI. It's the orchestration half of the control/data-plane split: the CLI
owns the mechanism (`discord post --file`, cortex ≥ v5.13.0); this action is
the surface a pipeline calls — exactly how `A_NOTIFY_MATTERMOST` delivers to
Mattermost.

## Boundary — read this

**Internal delivery only.** Use it for a digest, a report, a build artifact
posted to a channel we own. **Do not wire it into the diplomatic-pouch
pipelines.** The pouch (Foreign Policy §1, `compass/sops/peer-contact.md`) is
human-relayed by design — no live API, no webhook, no auto-transmit. Auto-
posting a pouch note to a peer would break rung-1 trust. This action lives on
our side of the fence.

## Usage

```yaml
actions:
  - A_RENDER_REPORT          # produces report_path + a summary in the payload
  - A_NOTIFY_DISCORD         # delivers it
```

Payload / env config:

| field | env fallback | meaning |
|-------|--------------|---------|
| `discord_channel` | `DISCORD_CHANNEL` | target channel name (required to send) |
| `discord_message` | — | message text (optional when files are given) |
| `discord_files` | — | array of local file paths to attach (non-string/empty entry = error) |
| `discord_files_root` | `DISCORD_FILES_ROOT` | confinement root — every attachment must resolve under it (set when the file list is untrusted) |
| `discord_server` | `DISCORD_SERVER` | named server profile (multi-guild) |

No channel resolves → the step is a passthrough no-op (pipelines run offline).
When configured, a failed post **fails the pipeline** — a system that thinks
it delivered but didn't is worse than a visible error.

## Requires

- The `discord` CLI on PATH (cortex ≥ v5.13.0 for `--file`), configured with a
  bot token (`discord config show`).
- The `shell` capability (declared in `action.json`).

Tests: `tests/notify-discord.test.ts` — command construction (channel / server
/ files / shell-quoted message), skip-when-unconfigured, and fail-on-nonzero,
all with a stub shell (no real CLI or token).
