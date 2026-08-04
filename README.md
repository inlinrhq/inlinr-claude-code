# inlinr-claude-code

Track your Claude Code sessions on [inlinr.com](https://inlinr.com) — time,
token usage, and how many lines the assistant actually wrote.

## Install

```sh
claude plugin marketplace add inlinrhq/inlinr-claude-code
claude plugin install inlinr@inlinr
```

The marketplace is named `inlinr`, not `inlinr-claude-code` — the install
target is `<plugin>@<marketplace>`, and the repository name plays no part in
it.

Then connect the machine once:

```sh
inlinr activate
```

The plugin needs the `inlinr` CLI on your `PATH`. If you already use the VS Code
extension you have it — the plugin also looks in `~/.inlinr/bin`.

## What it does

The plugin is one shell script bound to two hooks. It runs `inlinr sync-ai`
after each assistant turn (`Stop`) and when a session ends (`SessionEnd`).

Everything else lives in the CLI: finding Claude Code's transcripts, counting
tokens, computing line changes, resolving the git remote, rate-limiting, and
queueing while offline. Keeping the parsing there means one implementation
covers Claude Code in the terminal, in Claude Desktop, and inside VS Code —
and it means this plugin has nothing to break.

Two rules the hook never breaks:

- **It never fails your turn.** A `Stop` hook that exits non-zero interrupts
  your work; time tracking is never worth that. Every path exits 0.
- **It never prints.** Hook output is shown to you. A tracker that talks after
  every turn is a tracker you uninstall. Diagnostics go to
  `~/.inlinr/claude-code-hook.log`.

## What gets sent

Read from `~/.claude/projects/**/*.jsonl` — the transcripts Claude Code already
writes on your machine:

| Sent | Not sent |
|---|---|
| File paths that were edited | File contents |
| Lines added / removed per edit | The code itself |
| Input / output / cache token counts | Your prompts |
| Model name, session id | Assistant responses |
| Repository remote and branch | Anything from a folder with no git remote |

Sessions started outside a git repository are skipped entirely — there is no
project to attribute the work to.

## Troubleshooting

Nothing showing up? Run the sync by hand and read what it says:

```sh
inlinr sync-ai --dry-run
```

It reports how many beats it would send, how many transcripts it read, and how
many sessions it skipped for having no git remote. `~/.inlinr/claude-code-hook.log`
has the hook's own output.

Safe to run as often as you like: a watermark means it only reads transcript
lines written since last time, and a lock stops two editors double-counting.

## License

BSD-3-Clause
