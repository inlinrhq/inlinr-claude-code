# inlinr-claude-code

> **Reprise de session** — sur le poste local, lis d'abord `../PROGRESS.md` (racine du
> workspace, absent d'un clone seul) : il tient l'état du chantier en cours. Mets-le à jour
> après chaque modification.

Claude Code plugin for inlinr. Reads Claude Code's own transcripts
(`~/.claude/projects/**/*.jsonl`, subagents included), and the session files
of Codex (`~/.codex/sessions/`) and Gemini CLI (`~/.gemini/tmp/*/chats/`) on
the same machine, turns them into heartbeats with tokens and AI-written
lines, and posts them to `https://inlinr.com/api/v1/heartbeats` itself. Node
only: no binary, it does not use `inlinr-cli`. This repository is where every
assistant's parser lives (inlinr-cli's CLAUDE.md says the same).

Sibling repos:
- `inlinrhq/inlinr-web` — server. Source of truth for the wire contract below.
- `inlinrhq/inlinr-cli` — the binary the VS Code extension uses. Shares the
  machine's connection: `[auth] device_token` in `~/.inlinr/config.toml` is
  read and written by both (`machineToken` / `saveMachineToken` in
  `src/config.ts`, one line edited, the rest of the file kept), and
  `error_reports` under `[behavior]` is read here.
- `inlinrhq/inlinr-vscode` — the editor extension. Independent of this plugin.

## Layout

```
.claude-plugin/marketplace.json  # marketplace: inlinr (./plugin) and inlinr-cloud (./cloud)
plugin/           # what is published: the plugin tree, nothing else (see below)
plugin/.claude-plugin/plugin.json # plugin manifest (version, directory listing fields)
plugin/skills/{activate,status,deactivate,cloud,upgrade}/SKILL.md   # the /inlinr:* commands
plugin/dist/index.js              # the committed bundle Claude Code actually runs
src/index.ts      # entry: dispatches to a command, never breaks the turn on failure
src/commands/     # one file per command: activate, cloud, deactivate, session-check, setup, status, sync
src/sessions.ts   # every session file on the machine, what is new since the last read
src/repo.ts       # the repository (remote or folder name, branch) a directory belongs to
src/failure.ts    # a failed hook: ~/.inlinr/claude-code.log and the error report
src/version.ts    # VERSION
src/transcript.ts # JSONL parser: edits, lines, tokens, sessions, carry-over
src/agents/codex.ts   # Codex rollouts: apply_patch edits, token_count / token_usage_record
src/agents/gemini.ts  # Gemini CLI sessions: messages rewritten by id, diffStat lines
src/agents/sources.ts # where each assistant's files are, and their state keys
src/agents/setup.ts   # `setup codex|gemini-cli`: the hook for a machine without Claude Code
src/api.ts        # device flow, heartbeat batches, revoke
src/config.ts     # ~/.inlinr/claude-code.json (read positions), the machine's token in config.toml
src/notice.ts     # what SessionStart tells Claude when the machine is not connected
src/report.ts     # own failures → POST /api/v1/plugin-errors
dist/index.js     # the same bundle, copied by the build: inlinr.com pins it by commit,
                  # and repository hooks of releases before 0.8.1 fetch it from main
cloud/            # inlinr-cloud: the companion plugin, one mcp_tool hook (claim_session)
```

## How it runs

- The plugin declares **no hook**: Anthropic's directory accepts command hooks
  only from Verified organizations (`LOCAL_CODE_HOOK_COMMAND`, 6/11). After
  the user agrees, `/inlinr:activate` runs `setup claude-code`
  (`src/agents/setup.ts`): the bundle is copied to `~/.inlinr/agents.js` and
  seven hooks marked `--from claude-code` go into `~/.claude/settings.json`:
  SessionStart, PreCompact, Stop and SessionEnd sync; UserPromptSubmit,
  PostToolUse and SubagentStop sync throttled to 120 s. Every one is
  `async`: a tracker must never slow or break the turn it measures, so every
  path exits 0 except interactive `activate`. Run as that copy, a sync takes
  a newer build from `<claude home>/plugins/cache/*/inlinr/<version>/`
  (`refreshFromPlugin`). `deactivate --machine` and `setup claude-code
  --remove` take the hooks out. Never add a `type: "command"` hook back to
  `plugin/`.
- Each transcript keeps its own read offset in `claude-code.json`;
  `lastParsedAt` is set once at activation and never moved, so nothing from
  before activation is sent.
- One token per machine. `connection`: this file's `deviceToken` (saved by
  a release before 0.7.0, moved to `config.toml` by the first sync when that
  has none), then `config.toml`'s, then `INLINR_TOKEN` (only when the machine
  has no token: a repository can set it). `tokenSource` is the same, null
  while `paused`.
- `paused` (`deactivate --pause`): this plugin off, the machine's connection
  kept. A file with no token, no `lastParsedAt` and no `paused` key was left
  by an older `deactivate` and reads as paused. `deactivate --machine`
  revokes and clears the token everywhere; without a flag it only explains.
- `activate` on a machine already connected checks the token
  (`/api/v1/me/today`) and only resumes; `--replace` (or a refused token)
  runs the device flow and revokes the tokens it replaces.
- `tokenTag` (16 hex of the token's SHA-256) records which token the read
  positions belong to: when another appears (a sign-out and sign-in from the
  CLI or VS Code), tracking starts over from then.
- `save` keeps the `deviceToken` on disk unless called with `"set"`, so a
  sync never writes back a token cleared while it ran.
- `INLINR_HOME` moves `~/.inlinr` only under `NODE_ENV=test`.
- Failures go to `~/.inlinr/claude-code.log` (shown by `/inlinr:status`) and,
  once a day per error, to Admin → Errors. Off with `error_reports = false`,
  `INLINR_ERROR_REPORTS=0`, or Claude Code's `DISABLE_ERROR_REPORTING` /
  `DISABLE_TELEMETRY`.
- Cloud sessions get the plugin when it is installed from Anthropic's
  plugin directory or uploaded to the claude.ai account (both are copied
  into `~/.claude/plugins/synced/` as a container starts: seen on 4/11 for
  an uploaded `inlinr-cloud`, whose hook ran there). Since 0.9.0 it runs
  nothing there, having no hook: a cloud session is tracked by
  `inlinr-cloud` and the connector, or by inlinr.com's setup line, which
  installs its own hooks (`session-check` included) around the bundle
  pinned in inlinr-web.
  Repository hooks of older releases download `dist/index.js` from `main`:
  **so `main`'s `dist/` is live for them the moment it merges.**
- `plugin/` is the only folder the marketplace and the directory read. Dev
  files (`package.json`, `bun.lock`, this file, `.claude/`) stay outside it:
  a `package.json` with a lockfile in a plugin's folder makes Claude Code
  run an install there on every user's machine, and the directory holds it
  for review.
- Codex and Gemini CLI files are read by the same sync, with their own
  state in `files` (`agent`). A Codex file is keyed by its name, not its
  path: archiving moves it. Without Claude Code, `setup` copies the bundle
  to `~/.inlinr/agents.js` and adds Codex's `notify` or Gemini CLI's
  `AfterAgent` / `SessionEnd` hooks; `--detach` returns at once (Gemini CLI
  waits for its hooks) and the plugin refreshes that copy when it is newer.
- Work outside any git repository is skipped (no project to put it in; it
  is often the parent folder of several). A repository with no remote is
  sent as `project`, its folder's name (needs inlinr-web with `project`).
  `origin` first, else the first remote: the same rule as the CLI and the
  extension.

## Releasing

1. Change `src/`, then `bun run build` (writes `plugin/dist/index.js` and
   copies it to `dist/index.js`): CI fails when either does not match `src/`.
2. Bump the version in **four** places, which `scripts/check-version.mjs`
   (CI) checks agree: `package.json`, `plugin/.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, `const VERSION` in `src/version.ts`.
3. Merge to `main`. Users get it through the marketplace (`autoUpdate`) and
   cloud hooks at once; there is no tag step. Describe the release in the PR
   and keep README.md true (commands, what gets sent, troubleshooting).
4. A field the server does not accept yet ships in inlinr-web first.

```bash
bun install
bun test
bunx tsc --noEmit
bunx biome ci .
bun run build
```

## Contract (sync with `inlinrhq/inlinr-web` — verify before changing)

- Server: `https://inlinr.com` only (`trustedApiUrl` in `src/config.ts`);
  `INLINR_API_URL` or a saved `apiUrl` elsewhere is ignored, `localhost`
  excepted, since a repository can set Claude Code's environment.
- Device flow: `POST /api/auth/device` with
  `{ client_name, editor: "claude-code", platform }`, then poll
  `POST /api/auth/device/token`; revoke with `POST /api/auth/device/revoke`.
  The token is `in_d_…`, sent as `Authorization: Bearer`.
- Beats: `POST /api/v1/heartbeats`, up to 1000 per request, the wire format in
  inlinr-cli's CLAUDE.md. This plugin sends `editor` and `ai_tool` both set
  to the assistant (`claude-code`, `codex` or `gemini-cli`), `category` `coding` (an edit) or `ai-coding`
  (activity), `ai_session`, `ai_model`, the four token fields (uncached input,
  cache read, cache write, output) and line counts. It sends no `language`:
  the server infers it.
- Token totals in a transcript are running totals per message id: a later
  line supersedes an earlier one, never adds to it.
- Errors: `POST /api/v1/plugin-errors` with `source: "claude-code"`.

## Conventions

- Biome, 2 spaces, double quotes; TypeScript strict; `bun test`.
- A sync prints nothing. `session-check` (the SessionStart hook of
  inlinr.com's setup line) prints only the notice (Claude Code adds a
  SessionStart hook's stdout to the session), and only when the
  machine is not connected; the interactive commands (`activate`, `status`,
  `deactivate`, `--version`) print for the person running them.
- Nothing from a transcript but paths, line counts, token counts, model and
  session id ever leaves the machine. No prompt, no response, no file content.
