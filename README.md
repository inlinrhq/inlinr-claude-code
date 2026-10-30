<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://inlinr.com/brand/inlinr-logo-on-dark.svg">
  <img alt="inlinr" src="https://inlinr.com/brand/inlinr-logo-on-light.svg" height="36">
</picture>

# inlinr-claude-code

Track your Claude Code sessions on [inlinr.com](https://inlinr.com) — time,
token usage, and how many lines the assistant actually wrote. Since 0.6.0 it
reads Codex and Gemini CLI sessions on the same machine too: see
[Codex and Gemini CLI](#codex-and-gemini-cli).

Works on macOS, Linux and Windows.

## Install

```
claude plugin marketplace add inlinrhq/inlinr-claude-code
claude plugin install inlinr@inlinr --scope user
```

`--scope user` installs it for every project on the machine. Installed for one
project only, the plugin runs in that project's sessions and nowhere else —
which looks exactly like an activation that only covers one session.

Then, once, inside Claude Code:

```
/inlinr:activate
```

That prints a link, you approve it in the browser, and it saves a device token
in `~/.inlinr`. That covers the machine: every session, every project, the
terminal and the desktop app alike. There is nothing else to install.

**One connection per machine.** Since 0.7.0 the token is saved in
`~/.inlinr/config.toml`, where the inlinr VS Code extension and the `inlinr`
command read theirs. Connect any one of them and the others are connected:
with the extension already signed in, this plugin tracks without
`/inlinr:activate`, from the moment it first runs, and Claude says so once in
that first session. A machine activated by an earlier release has its token
moved from `~/.inlinr/claude-code.json` to the shared file at the first sync
(when that file has none), so the extension uses it too.

On a machine already connected, `/inlinr:activate` does not ask for a new
approval: it keeps the connection and resumes tracking. To move the machine to
another inlinr account, ask for activation with `--replace`; every plugin on
the machine moves with it, and the old device is revoked.

A machine where this plugin was deactivated with an earlier release stays off
for Claude Code even if the extension is signed in: `/inlinr:activate` turns it
back on.

**Tracking starts when you activate, not before.** Claude Code keeps every
transcript it has ever written, so a first sync could otherwise upload months
of past work — attributed to projects you may never have wanted tracked — the
moment you connect a plugin. Nobody asks for that by activating something.

A slash command rather than a path to type, because the installed path contains
a version number — `~/.claude/plugins/cache/inlinr/inlinr/<version>/` — so any
path in a readme is wrong the moment the plugin updates, and `~` does not expand
in `cmd.exe` either. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` for us.

## Commands

| Command | What it does |
|---|---|
| `/inlinr:activate` | Connect this machine. Opens a page, you approve it there. |
| `/inlinr:status` | Which build is running, whether it is connected, when it last synced, how many transcripts are in scope. |
| `/inlinr:deactivate` | Pause Claude Code tracking here, or disconnect the machine (asks which). |
| `/inlinr:cloud` | Get a token and the setup for Claude Code cloud sessions. See [Cloud sessions](#cloud-sessions). |
| `/inlinr:upgrade <package> [version]` | Upgrade an npm dependency: reads its breaking changes, migration guides and advisories from inlinr, finds where the code uses it, upgrades, fixes and runs your checks. Only the package name and the two versions are sent. |

You do not have to type them. Ask Claude in plain words ("is inlinr
tracking?", "connect inlinr", "update inlinr") and it runs the right one, which
is the only way in the desktop app's chat. `deactivate` is the exception: it
only runs when you type it.

If a session starts on a machine that is not connected, or whose device was
removed from your account, Claude is told so and offers to fix it. Nothing is
said when tracking works.

There is deliberately no command to list your languages, sessions or files. The
dashboard shows all of that with a period picker and drill-down, and a table of
languages printed into a terminal is a thing people run once. `status` exists
because "is this actually working" is a question you have *here*, in the
session, and cannot answer from the dashboard — an empty dashboard looks the
same whether nothing was tracked or nothing was sent.

## Codex and Gemini CLI

Codex (the CLI and the desktop app) and Gemini CLI write their sessions to
disk, like Claude Code: `~/.codex/sessions/` (or `$CODEX_HOME`) and
`~/.gemini/tmp/<project>/chats/`. Every sync reads them as well, so **with the
plugin installed and activated, there is nothing to do**: work in Codex or
Gemini CLI shows up on inlinr under that assistant, with its model, tokens and
the lines it wrote, the next time Claude Code syncs.

Without Claude Code, run the same script from your assistant's own hook. It
needs Node 18 or later:

```
curl -fsSL https://github.com/inlinrhq/inlinr-claude-code/raw/main/dist/index.js -o inlinr.js
node inlinr.js activate --editor codex     # or gemini-cli
node inlinr.js setup codex                  # or gemini-cli
```

`setup` copies the script to `~/.inlinr/agents.js` and adds one hook:

- **Codex**: `notify` in `~/.codex/config.toml`, run after each turn. Codex
  takes a single `notify` program; if you already have one, `setup` leaves it
  and prints the command to call from it.
- **Gemini CLI**: an `AfterAgent` and a `SessionEnd` hook in
  `~/.gemini/settings.json`, named `inlinr`. Gemini CLI waits for its hooks,
  so this one hands the sync to a background process and returns at once.

Run both commands again to update the copy. With the Claude Code plugin on the
same machine, the plugin keeps `~/.inlinr/agents.js` on its own version.

As with Claude Code, tracking starts at activation: sessions from before are
not sent. Codex counts tokens per response; cached input is reported apart
from input. Gemini CLI 0.38 and older wrote sessions as one JSON file
rewritten whole, which is not read.

## Cloud sessions

Claude Code on the web runs each session in a fresh container, and it does not
install plugins — not yours, not even the ones a repository enables. Two things
do carry over: the environment's variables, and the hooks in a repository's
own `.claude/settings.json`. So cloud tracking is the same script, run by a hook
committed to the repository, with a token from the environment:

1. Run `/inlinr:cloud` on your machine and approve it. It prints a token and a
   hooks block.
2. In the cloud environment's settings, add `INLINR_TOKEN=<token>`, set network
   access to Custom with `inlinr.com` added (keep the default package managers),
   and save.
3. Merge the hooks block into `.claude/settings.json` in each repository you
   work on in the cloud, and commit it.

The hooks do nothing outside the cloud (`CLAUDE_CODE_REMOTE` is only set
there), so they never double-count with the plugin on your machine. Claude Code
reads a repository's hooks only in single-repository cloud sessions.

`INLINR_TOKEN` works on any machine, not only in the cloud: a token from the
environment is used whenever none has been saved by `/inlinr:activate`.

The token and the beats only ever go to `https://inlinr.com`: since 0.5.1 an
`INLINR_API_URL` pointing anywhere else (a repository can set environment
variables for Claude Code) is ignored, except `localhost` for development.

## Updating

```
claude plugin update inlinr@inlinr
```

The plugin cache is keyed by version and will not re-fetch one it already has,
so if that changes nothing, uninstall and install again. `/inlinr:status`
prints the running version, which is the fastest way to tell whether an update
actually took. In the desktop app, ask Claude to update inlinr, or use the
`/plugin` menu.

To have every machine update on its own, set `autoUpdate` on the marketplace
in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "inlinr": {
      "source": { "source": "github", "repo": "inlinrhq/inlinr-claude-code" },
      "autoUpdate": true
    }
  }
}
```

## Disconnecting

```
/inlinr:deactivate
```

Claude asks which of two you mean:

- **Pause** (`deactivate --pause`): Claude Code, Codex and Gemini CLI are no
  longer tracked on this machine. The inlinr extension and the `inlinr`
  command keep the machine's connection; nothing is revoked.
- **Disconnect the machine** (`deactivate --machine`): the token is revoked on
  inlinr.com and cleared, and every inlinr plugin on the machine stops.
  Signing out from the extension or the `inlinr` command does the same.

Your history is untouched either way. `/inlinr:activate` resumes after a pause
or connects the machine again; tracking starts from that moment, and what was
done while paused or signed out is not sent.

**If the plugin seems stuck on an old version**, see [Updating](#updating).

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

Seven hooks, all running the plugin's own `dist/index.js`. Two kinds:

| Hook | Why |
|---|---|
| `UserPromptSubmit`, `PostToolUse`, `SubagentStop` | Throttled to one sync every two minutes. These make a long session show up *while* it happens rather than only at the end. |
| `SessionStart`, `Stop`, `SessionEnd`, `PreCompact` | Unthrottled. The start sets the clock on a machine that has a token but has never synced; the others are the moments that mean "this is over". |

A sync that ran within the throttle exits before touching the filesystem, so a
hook firing on every tool call costs a process spawn and nothing else. Each
transcript is read from where the last sync stopped, so nothing is read or sent
twice, and positions are saved only once the server has the beats.

All seven are `async`, so nothing waits on them. That is the real guarantee that
a tracker never costs you a turn. The script also never exits non-zero from a
hook, as a second line of defence; failures go to `~/.inlinr/claude-code.log`,
and `/inlinr:status` points at it.

### How time is counted

Time is the gaps between beats, as everywhere on inlinr: a gap under your
keystroke timeout counts, a longer one means you walked away. So what matters
is that a beat exists for every stretch of real work:

- **One activity beat per minute** in which the session did anything — a
  prompt, a response, a tool result — at the moment the transcript says it
  happened. Reading code, running tests and waiting on a long answer are work
  too. When only file edits produced beats, twenty minutes of investigation
  before a one-line fix came out as nothing.
- **One file beat per file per two minutes** the assistant edited, carrying how
  many lines it added and removed.
- **Subagents count.** Their transcripts sit in their own files, and those are
  read too.

### Which project

Where the work happened, not where the session started. An edit belongs to the
repository its file is in; activity belongs to the repository of the directory
the session stood in at that moment. A session started in a folder that holds
several repositories gives its activity to the one it was editing nearest in
time. The branch is the one checked out when the sync runs.

### Two things that are easy to get wrong

- **Token totals in the transcript are running, not incremental.** The same
  message id is logged repeatedly while a response streams, each time with the
  totals so far. Summing the lines multiplies a response's cost by the number
  of chunks, so the previous contribution is superseded rather than added —
  including across two syncs that land mid-stream.
- **Cache tokens are kept apart from input.** They bill at very different rates
  — reads well below the input rate, writes above it — and collapsing them into
  one figure priced at the input rate overstates a long session by close to an
  order of magnitude, because most of a Claude Code turn is re-read context.

## What gets sent

Read from `~/.claude/projects/**/*.jsonl` — the transcripts Claude Code already
writes on your machine — and from Codex's and Gemini CLI's session files:

| Sent | Not sent |
|---|---|
| File paths that were edited | File contents |
| Lines added / removed per edit | The code itself |
| Input / output / cache token counts | Your prompts |
| Model name, session id | Assistant responses |
| Repository remote and branch (the folder's name for a repository with no remote) | Anything from a folder outside any git repository |
| When the session was active, to the minute | |

Work that cannot be tied to any git repository is skipped — there is no
project to attribute it to. A repository with no remote (local only, or not
pushed yet) is tracked under its folder's name; the path is never sent.

When a sync fails on your machine (not a network error, not the server
refusing it), the plugin tells inlinr, at most once a day for the same error:
the error message and stack with your home folder replaced by `~`, the plugin
version and your operating system. No token, nothing from the transcripts.
Turn it off with `error_reports = false` under `[behavior]` in
`~/.inlinr/config.toml`, `INLINR_ERROR_REPORTS=0`, or Claude Code's own
`DISABLE_ERROR_REPORTING` / `DISABLE_TELEMETRY`.

## Troubleshooting

**Nothing shows up.** Run `/inlinr:status`. It says whether this machine is
connected, when it last synced, how many transcripts have something new, and
whether errors have been logged.

**Cloud sessions do not show up.** Check that the environment has
`INLINR_TOKEN`, that `inlinr.com` is in its network allowlist, and that the
session has a single repository whose `.claude/settings.json` has the hooks.

## License

BSD-3-Clause
