import { isAbsolute, resolve } from "node:path";
import {
  type Activity,
  emptyTokens,
  type FileEdit,
  type Session,
  type Tokens,
} from "../transcript";

/**
 * Reading Codex's session files.
 *
 * Codex (the CLI, and the desktop app, which writes the same files) keeps one
 * JSONL "rollout" per session under `~/.codex/sessions/YYYY/MM/DD/`, moved to
 * `~/.codex/archived_sessions/` when archived. Each line is
 * `{ timestamp, type, payload }`:
 *
 * - `session_meta`, the first line only: the session id and its folder.
 * - `turn_context`, before each turn: the folder and the model.
 * - `response_item`: messages and tool calls, `apply_patch` among them.
 * - `event_msg`: lifecycle events, `token_count` among them.
 * - `token_usage_record` (newer builds): one per model response.
 *
 * The format is Codex's own and undocumented, so everything is read
 * defensively: a line that does not have the expected shape is skipped.
 *
 * What is subtle:
 *
 * **Only the first line names the session.** A sync reads from where the
 * last one stopped, so the session id, the folder and the model are carried
 * from one read to the next (`CodexState`).
 *
 * **Token counts come twice in newer builds.** A `token_usage_record` per
 * response, and the older `token_count` event per turn, which carries both
 * the turn's usage and the running total and is re-emitted unchanged at
 * times. Once a file has a record, records alone count. Before that,
 * `token_count` counts, skipping an event whose running total did not move.
 *
 * **OpenAI counts cached input inside input.** It is taken out, so `input`
 * stays the uncached part, as it is for Claude Code.
 *
 * **A patch counts once it applied.** The `apply_patch` call carries the
 * patch; its output, a line or more later, says whether it went through. A
 * rejected patch is usually retried, and counting both would double the
 * lines. A patch whose output has not been read yet waits in the state.
 *
 * **A fork replays its parent.** A forked session copies the parent's history
 * first, with the parent's timestamps: anything older than the fork's own
 * `session_meta` is skipped.
 */

type CodexUsage = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
};

type PendingPatch = { at: string; cwd: string; edits: PatchFile[] };

export type CodexState = {
  sessionId: string;
  cwd: string;
  model: string;
  /** When the session began; earlier lines are a fork's replay. */
  startedAt: string | null;
  /** The last running total seen in a `token_count` event. */
  lastTotal: number | null;
  /** The file has per-response records: `token_count` no longer counts. */
  records: boolean;
  /** Patches whose output has not been read yet, by call id. */
  pending: Record<string, PendingPatch>;
};

export const emptyCodexState = (): CodexState => ({
  sessionId: "",
  cwd: "",
  model: "",
  startedAt: null,
  lastTotal: null,
  records: false,
  pending: {},
});

/** A patch that never got an output is given up after this long. */
const PENDING_TTL_MS = 10 * 60 * 1000;

const n = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Codex's usage, with cached input taken out of input. */
export function codexTokens(usage: CodexUsage | null | undefined): Tokens {
  if (!usage) return emptyTokens();
  const cacheRead = n(usage.cached_input_tokens);
  const cacheWrite = n(usage.cache_write_input_tokens);
  return {
    input: Math.max(0, n(usage.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: n(usage.output_tokens),
  };
}

export type PatchFile = { path: string; added: number; removed: number };

/**
 * The files an `apply_patch` patch touches, with its lines.
 *
 * The format is Codex's own (`*** Begin Patch`, `*** Update File: <path>`,
 * then hunks of ` `, `-` and `+` lines). A deleted file's lines are not in
 * the patch, so a deletion counts as a touch with no line delta.
 */
export function parsePatch(patch: string, cwd: string): PatchFile[] {
  const files: PatchFile[] = [];
  const where = (p: string) =>
    isAbsolute(p) || !cwd ? p : resolve(cwd, p);
  let current: PatchFile | null = null;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) {
      current = { path: where((file[1] ?? "").trim()), added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.path = where((move[1] ?? "").trim());
      continue;
    }
    if (line.startsWith("***")) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  return files;
}

/** The patch text of an `apply_patch` call, or null for any other call. */
function patchOf(payload: Record<string, unknown>): string | null {
  if (payload.name !== "apply_patch") return null;
  if (payload.type === "custom_tool_call") return str(payload.input) || null;
  if (payload.type === "function_call") {
    try {
      const args = JSON.parse(str(payload.arguments)) as {
        input?: unknown;
        patch?: unknown;
      };
      return str(args.input) || str(args.patch) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether a tool output says the patch went through. */
function applied(output: unknown): boolean {
  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? JSON.stringify(output)
        : "";
  return /Success\. Updated the following files|Exit code: 0\b|"exit_code":\s*0\b/.test(
    text,
  );
}

export type CodexOptions = {
  /** Skip lines at or before this instant. */
  since?: Date | null;
  state?: CodexState | null;
};

export function parseCodex(
  content: string,
  options: CodexOptions = {},
): { session: Session | null; state: CodexState } {
  const state: CodexState = {
    ...emptyCodexState(),
    ...options.state,
    pending: { ...options.state?.pending },
  };
  const sinceMs = options.since ? options.since.getTime() : null;
  const tokens = emptyTokens();
  const edits: FileEdit[] = [];
  const activity: Activity[] = [];
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  const add = (t: Tokens) => {
    tokens.input += t.input;
    tokens.cacheRead += t.cacheRead;
    tokens.cacheWrite += t.cacheWrite;
    tokens.output += t.output;
  };

  const commit = (callId: string, at: string) => {
    const patch = state.pending[callId];
    delete state.pending[callId];
    if (!patch) return;
    for (const f of patch.edits) {
      edits.push({
        path: f.path,
        timestamp: at,
        lineChanges: f.added - f.removed,
        linesAdded: f.added,
        linesRemoved: f.removed,
        cwd: patch.cwd,
      });
    }
  };

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let entry: { timestamp?: unknown; type?: unknown; payload?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload =
      entry.payload && typeof entry.payload === "object"
        ? (entry.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const ts = Date.parse(str(entry.timestamp));
    if (Number.isNaN(ts)) continue;

    if (entry.type === "session_meta") {
      state.sessionId = str(payload.id) || str(payload.session_id);
      state.cwd = str(payload.cwd) || state.cwd;
      state.startedAt = str(payload.timestamp) || new Date(ts).toISOString();
      continue;
    }
    if (entry.type === "turn_context") {
      state.cwd = str(payload.cwd) || state.cwd;
      state.model = str(payload.model) || state.model;
      continue;
    }

    const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    if (!Number.isNaN(started) && ts < started) continue;
    if (sinceMs !== null && ts <= sinceMs) continue;

    const at = new Date(ts).toISOString();

    if (entry.type === "token_usage_record") {
      state.records = true;
      add(codexTokens(payload.usage as CodexUsage));
      continue;
    }

    if (entry.type === "event_msg") {
      if (payload.type === "token_count") {
        if (state.records) continue;
        const info = payload.info as {
          total_token_usage?: CodexUsage;
          last_token_usage?: CodexUsage;
        } | null;
        if (!info) continue;
        const total = info.total_token_usage?.total_tokens;
        if (typeof total === "number") {
          if (total === state.lastTotal) continue;
          state.lastTotal = total;
        }
        add(codexTokens(info.last_token_usage));
        continue;
      }
      // Older builds say whether a patch applied here as well.
      if (payload.type === "patch_apply_end") {
        const id = str(payload.call_id);
        if (payload.success === true) commit(id, at);
        else delete state.pending[id];
      }
    } else if (entry.type === "response_item") {
      const patch = patchOf(payload);
      const callId = str(payload.call_id);
      if (patch !== null && callId) {
        state.pending[callId] = {
          at,
          cwd: state.cwd,
          edits: parsePatch(patch, state.cwd),
        };
      } else if (
        (payload.type === "custom_tool_call_output" ||
          payload.type === "function_call_output") &&
        state.pending[callId]
      ) {
        if (applied(payload.output)) commit(callId, at);
        else delete state.pending[callId];
      }
    } else {
      continue;
    }

    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;
    activity.push({ at, cwd: state.cwd });
  }

  // A patch whose output never came: the call was interrupted.
  const newest = lastSeen ?? Date.now();
  for (const [id, p] of Object.entries(state.pending)) {
    if (newest - Date.parse(p.at) > PENDING_TTL_MS) delete state.pending[id];
  }

  if (!state.sessionId) return { session: null, state };
  return {
    session: {
      tool: "codex",
      id: state.sessionId,
      cwd: state.cwd,
      model: state.model,
      tokens,
      edits,
      activity,
      firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      carry: null,
    },
    state,
  };
}
