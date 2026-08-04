# inlinr-claude-code

Track your Claude Code sessions on [inlinr.com](https://inlinr.com) — time,
token usage, and how many lines the assistant actually wrote.

Works on macOS, Linux and Windows.

## Install

The plugin runs the `inlinr` CLI, so install that first and make sure it is on
your `PATH`.

**macOS / Linux**

```sh
curl -fsSL https://inlinr.com/install.sh | sh
inlinr activate
```

**Windows (PowerShell)**

```powershell
irm https://inlinr.com/install.ps1 | iex
inlinr activate
```

The script verifies the published SHA-256 before installing, puts the binary in
`%LOCALAPPDATA%\Inlinr\bin`, adds that to your `PATH`, and sets it for the
current session as well — so `inlinr activate` works straight away rather than
after a restart nobody expects.

**If you have Go, this is simpler and cannot trip an antivirus:**

```
go install github.com/inlinrhq/inlinr-cli/cmd/inlinr@latest
```

Nothing is downloaded as an executable, and the binary lands in your GOPATH bin.

It also avoids the SmartScreen dialog you get downloading the `.exe` in a
browser, and not by suppressing it: that warning comes from Mark-of-the-Web,
and `Invoke-WebRequest` does not attach the tag that triggers it. Same binary,
different provenance metadata. To install by hand instead, see the
[CLI readme](https://github.com/inlinrhq/inlinr-cli#downloading-the-binary-by-hand).

Finally, add the plugin:

```sh
claude plugin marketplace add inlinrhq/inlinr-claude-code
claude plugin install inlinr@inlinr
```

The marketplace is named `inlinr`, not `inlinr-claude-code` — the install target
is `<plugin>@<marketplace>`, and the repository name plays no part in it.

> **The VS Code extension does not put the CLI on your PATH.** It downloads its
> own copy into VS Code's private extension storage, where nothing else can find
> it. If you use both, install the CLI separately as above.

## What it does

Six hooks, all running `inlinr sync-ai`. Two kinds:

| Hook | Why |
|---|---|
| `UserPromptSubmit`, `PostToolUse`, `SubagentStop` | Throttled to one sync every two minutes. These make a long session show up *while* it happens rather than only at the end. |
| `Stop`, `SessionEnd`, `PreCompact` | Unthrottled. These are the moments that mean "this is over" — a session that ends abruptly must not leave its last stretch unsynced. |

It used to be two hooks — `Stop` and `SessionEnd` — which meant a four-hour
session appeared in one lump at the end, and a crash before the end appeared
not at all.

The throttle lives in the CLI rather than in the hook, because that is where
the state already is: a sync that ran a minute ago exits before touching the
filesystem, so a hook firing on every tool call costs a process spawn and
nothing else. Syncing is idempotent either way — a watermark means only new
transcript lines are read, and a lock means two editors cannot double-count.

All six are `async`, so nothing waits on them. That is the real guarantee that a
tracker never costs you a turn — an exit code you have to get right is a weaker
one. `inlinr sync-ai` also never exits non-zero, as a second line of defence.

That is the entire plugin — there is no wrapper script. It used to ship a POSIX
`sh` file, which assumed every platform gives Claude Code an `sh` to run it
with. Invoking the CLI directly removes the assumption: `PATH` lookup is
something every shell does on every platform, and the "never break the turn"
guarantee moves into the CLI where it is one line and can be tested.

Everything else lives in the CLI: finding Claude Code's transcripts, counting
tokens, computing line changes, resolving the git remote, rate-limiting, and
queueing while offline. Keeping the parsing there means one implementation
covers Claude Code in the terminal, in Claude Desktop, and inside VS Code.

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

**Nothing shows up.** Run the sync by hand and read what it says:

```sh
inlinr sync-ai --dry-run
```

It reports how many beats it would send, how many transcripts it read, and how
many sessions it skipped for having no git remote.

**`inlinr: command not found` in the hook output.** The CLI is not on the `PATH`
Claude Code sees. On Windows that is usually a terminal opened before the `PATH`
change — reopen it, and check with `inlinr --version` in the same terminal you
run `claude` from.

Safe to run as often as you like: a watermark means it only reads transcript
lines written since last time, and a lock stops two editors double-counting.

## License

BSD-3-Clause
