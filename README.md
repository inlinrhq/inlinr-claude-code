# inlinr-claude-code

Track your Claude Code sessions on [inlinr.com](https://inlinr.com) — time,
token usage, and how many lines the assistant actually wrote.

Works on macOS, Linux and Windows.

## Install

```
claude plugin marketplace add inlinrhq/inlinr-claude-code
claude plugin install inlinr@inlinr
```

Then, once, inside Claude Code:

```
/inlinr:activate
```

That prints a link, you approve it in the browser, and it saves a device token.
There is nothing else to install.

A slash command rather than a path to type, because the installed path contains
a version number — `~/.claude/plugins/cache/inlinr/inlinr/<version>/` — so any
path in a readme is wrong the moment the plugin updates, and `~` does not expand
in `cmd.exe` either. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` for us.

**If the plugin seems stuck on an old version**, the cache is keyed by version
number and will not re-fetch one it already has:

```
claude plugin uninstall inlinr@inlinr
claude plugin install inlinr@inlinr
```

**No binary, no PATH, no antivirus argument.** Claude Code is a Node program,
so Node is on the machine by definition — the plugin reads the transcripts,
talks to the API and stores its token itself. Asking someone to download an
unsigned executable and then argue with Windows Defender about it, in order to
hand an API key to a plugin, was the wrong trade.

The [`inlinr` CLI](https://github.com/inlinrhq/inlinr-cli) still exists and is
still the right thing for editors that are not Node programs. It is no longer a
prerequisite for this one, and if you already have it activated, this plugin
uses the same `~/.inlinr` directory.

## What it does

Six hooks, all running the plugin's own `dist/index.js`. Two kinds:

| Hook | Why |
|---|---|
| `UserPromptSubmit`, `PostToolUse`, `SubagentStop` | Throttled to one sync every two minutes. These make a long session show up *while* it happens rather than only at the end. |
| `Stop`, `SessionEnd`, `PreCompact` | Unthrottled. These are the moments that mean "this is over" — a session that ends abruptly must not leave its last stretch unsynced. |

It used to be two hooks — `Stop` and `SessionEnd` — which meant a four-hour
session appeared in one lump at the end, and a crash before the end appeared
not at all.

A sync that ran within the throttle exits before touching the filesystem, so a
hook firing on every tool call costs a process spawn and nothing else. Syncing
is idempotent either way: a watermark means only new transcript lines are read.

All six are `async`, so nothing waits on them. That is the real guarantee that a
tracker never costs you a turn — an exit code you have to get right is a weaker
one. `inlinr sync-ai` also never exits non-zero, as a second line of defence.

That is the entire plugin — there is no wrapper script. It used to ship a POSIX
`sh` file, which assumed every platform gives Claude Code an `sh` to run it
with. Invoking the CLI directly removes the assumption: `PATH` lookup is
something every shell does on every platform, and the "never break the turn"
guarantee moves into the CLI where it is one line and can be tested.

Reading the transcripts, counting tokens, computing line changes and resolving
the git remote all happen here now. Two of those deserve a note because getting
them wrong is silent:

- **Token totals in the transcript are running, not incremental.** The same
  message id is logged repeatedly while a response streams, each time with the
  totals so far. Summing the lines multiplies a response's cost by the number
  of chunks, so the previous contribution is superseded rather than added.
- **Cache tokens are kept apart from input.** They bill at very different rates
  — reads well below the input rate, writes above it — and collapsing them into
  one figure priced at the input rate overstates a long session by close to an
  order of magnitude, because most of a Claude Code turn is re-read context.

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
