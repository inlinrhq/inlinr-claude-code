# inlinr-claude-code

> **Reprise de session** — sur le poste local, lis d'abord `../PROGRESS.md` (racine du
> workspace, absent d'un clone seul) : il tient l'état du chantier en cours. Mets-le à jour
> après chaque modification.

Claude Code plugin for Inlinr. Reads Claude Code's own transcripts
(`~/.claude/projects/**/*.jsonl`, subagents included), turns them into
heartbeats with tokens and AI-written lines, and posts them to
`https://inlinr.com/api/v1/heartbeats` itself. Node only: no binary, it does
not use `inlinr-cli`.

Sibling repos:
- `inlinrhq/inlinr-web` — server. Source of truth for the wire contract below.
- `inlinrhq/inlinr-cli` — the binary the VS Code extension uses. Shares the
  `~/.inlinr/` folder only: this plugin reads `config.toml` for
  `error_reports` under `[behavior]`, nothing else.
- `inlinrhq/inlinr-vscode` — the editor extension. Independent of this plugin.

## Layout

```
.claude-plugin/plugin.json       # plugin manifest (version)
.claude-plugin/marketplace.json  # marketplace entry (version)
hooks/hooks.json                 # when Claude Code runs us (see below)
skills/{activate,status,deactivate,cloud}/SKILL.md   # the /inlinr:* commands
src/index.ts      # entry: subcommands, transcript walk, sync, VERSION
src/transcript.ts # JSONL parser: edits, lines, tokens, sessions, carry-over
src/api.ts        # device flow, heartbeat batches, revoke
src/config.ts     # ~/.inlinr/claude-code.json (token, read positions)
src/notice.ts     # what SessionStart tells Claude when the machine is not connected
src/report.ts     # own failures → POST /api/v1/plugin-errors
dist/index.js     # the committed bundle Claude Code actually runs
```

## How it runs

- `hooks/hooks.json` runs `dist/index.js` on SessionStart (a 5 s
  `session-check`, then a sync), UserPromptSubmit, PostToolUse and
  SubagentStop (throttled to 120 s), PreCompact, Stop and SessionEnd. Every
  sync hook is `async`: a tracker must never slow or break the turn it
  measures, so every path exits 0 except interactive `activate`.
- Each transcript keeps its own read offset in `claude-code.json`;
  `lastParsedAt` is set once at activation and never moved, so nothing from
  before activation is sent.
- Failures go to `~/.inlinr/claude-code.log` (shown by `/inlinr:status`) and,
  once a day per error, to Admin → Errors. Off with `error_reports = false`,
  `INLINR_ERROR_REPORTS=0`, or Claude Code's `DISABLE_ERROR_REPORTING` /
  `DISABLE_TELEMETRY`.
- Cloud sessions do not install plugins: a repository's
  `.claude/settings.json` hook downloads `dist/index.js` from this
  repository's `main` and runs it only when `CLAUDE_CODE_REMOTE=true`, with
  the token from `INLINR_TOKEN`. **So `main`'s `dist/` is live the moment it
  merges.**
- Work outside any git repository is skipped (no project to put it in; it
  is often the parent folder of several). A repository with no remote is
  sent as `project`, its folder's name (needs inlinr-web with `project`).
  `origin` first, else the first remote: the same rule as the CLI and the
  extension.

## Releasing

1. Change `src/`, then `bun run build`: CI fails when `dist/` does not match
   `src/`.
2. Bump the version in **four** places, which `scripts/check-version.mjs`
   (CI) checks agree: `package.json`, `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, `const VERSION` in `src/index.ts`.
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
  inlinr-cli's CLAUDE.md. This plugin sends `editor: "claude-code"`,
  `ai_tool: "claude-code"`, `category` `coding` (an edit) or `ai-coding`
  (activity), `ai_session`, `ai_model`, the four token fields (uncached input,
  cache read, cache write, output) and line counts. It sends no `language`:
  the server infers it.
- Token totals in a transcript are running totals per message id: a later
  line supersedes an earlier one, never adds to it.
- Errors: `POST /api/v1/plugin-errors` with `source: "claude-code"`.

## Conventions

- Biome, 2 spaces, double quotes; TypeScript strict; `bun test`.
- A sync prints nothing. `session-check` prints only the notice (Claude Code
  adds a SessionStart hook's stdout to the session), and only when the
  machine is not connected; the interactive commands (`activate`, `status`,
  `deactivate`, `--version`) print for the person running them.
- Nothing from a transcript but paths, line counts, token counts, model and
  session id ever leaves the machine. No prompt, no response, no file content.
