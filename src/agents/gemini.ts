import {
  type Activity,
  emptyTokens,
  type FileEdit,
  type Session,
  type Tokens,
} from "../transcript";

/**
 * Reading Gemini CLI's session files.
 *
 * Gemini CLI keeps one JSONL file per session under
 * `~/.gemini/tmp/<project>/chats/session-*.jsonl`, and the project folder
 * holds a `.project_root` file with the folder the session ran in. The first
 * line is the session's metadata (`sessionId`, `projectHash`, `startTime`);
 * the rest are messages, `$set` metadata updates, `$patch` and `$rewindTo`
 * records.
 *
 * What is subtle:
 *
 * **A message is written again in full each time it changes.** A model
 * response is appended, then appended again with its tokens, then again with
 * each tool call it made. The same `id` therefore appears several times, and
 * the newest copy supersedes the older ones: tokens are counted once per
 * message id, and a tool call once per tool call id. Both sets of ids are
 * carried from one read to the next, since a sync can land between two
 * copies.
 *
 * **Gemini counts cached input inside input.** It is taken out, so `input`
 * stays the uncached part. Thinking tokens bill as output and are counted
 * there.
 *
 * **Lines come from the tool's own diff.** `write_file` and `replace` report
 * `diffStat` with the lines the model added and removed (as opposed to lines
 * the user changed in the proposed edit), which is what an AI-written line
 * means here.
 *
 * Gemini CLI 0.38 and older wrote one JSON document per session, rewritten
 * whole each time. Those files are not read: the version is months old, and
 * reading from an offset needs an append-only file.
 */

/** Ids kept to recognise a copy, newest last. A session's recent ones. */
const KEEP_IDS = 200;

export type GeminiState = {
  sessionId: string;
  /** Tokens already counted, by message id. */
  messages: Record<string, Tokens>;
  /** Tool calls already counted. */
  toolCalls: string[];
};

export const emptyGeminiState = (): GeminiState => ({
  sessionId: "",
  messages: {},
  toolCalls: [],
});

const EDIT_TOOLS = new Set(["write_file", "replace", "edit", "smart_edit"]);

const n = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

type GeminiTokens = {
  input?: unknown;
  output?: unknown;
  cached?: unknown;
  thoughts?: unknown;
};

/** Gemini's usage, with cached input taken out of input. */
export function geminiTokens(t: GeminiTokens | null | undefined): Tokens {
  if (!t) return emptyTokens();
  const cacheRead = n(t.cached);
  return {
    input: Math.max(0, n(t.input) - cacheRead),
    cacheRead,
    cacheWrite: 0,
    output: n(t.output) + n(t.thoughts),
  };
}

type ToolCall = {
  id?: unknown;
  name?: unknown;
  args?: Record<string, unknown> | null;
  status?: unknown;
  timestamp?: unknown;
  resultDisplay?: { diffStat?: Record<string, unknown> | null } | null;
};

export type GeminiOptions = {
  /** Skip messages at or before this instant. */
  since?: Date | null;
  state?: GeminiState | null;
  /** The folder the session ran in, from `.project_root`. */
  root?: string;
};

export function parseGemini(
  content: string,
  options: GeminiOptions = {},
): { session: Session | null; state: GeminiState } {
  const prior = options.state ?? emptyGeminiState();
  const messages = new Map(Object.entries(prior.messages));
  const toolCalls = new Set(prior.toolCalls);
  let sessionId = prior.sessionId;
  let model = "";
  const cwd = options.root ?? "";
  const sinceMs = options.since ? options.since.getTime() : null;
  const tokens = emptyTokens();
  const edits: FileEdit[] = [];
  const activity: Activity[] = [];
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  const seen = (ts: number) => {
    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;
    activity.push({ at: new Date(ts).toISOString(), cwd });
  };

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;

    // The metadata line: no message id.
    if (typeof record.sessionId === "string" && record.id === undefined) {
      sessionId = record.sessionId || sessionId;
      continue;
    }
    if (typeof record.id !== "string" || "$patch" in record) continue;
    const type = record.type;
    if (type !== "user" && type !== "gemini") continue;

    const ts = Date.parse(str(record.timestamp));
    if (Number.isNaN(ts)) continue;
    const fresh = sinceMs === null || ts > sinceMs;
    if (fresh && !messages.has(record.id)) seen(ts);
    if (type !== "gemini") continue;

    if (typeof record.model === "string" && record.model)
      model = record.model;

    const next = geminiTokens(record.tokens as GeminiTokens | null);
    const before = messages.get(record.id);
    if (fresh || before) {
      const was = before ?? emptyTokens();
      tokens.input += next.input - was.input;
      tokens.cacheRead += next.cacheRead - was.cacheRead;
      tokens.cacheWrite += next.cacheWrite - was.cacheWrite;
      tokens.output += next.output - was.output;
      // Re-inserted so the newest ids are the ones kept.
      messages.delete(record.id);
      messages.set(record.id, next);
    }

    const calls = Array.isArray(record.toolCalls)
      ? (record.toolCalls as ToolCall[])
      : [];
    for (const call of calls) {
      const id = str(call.id);
      if (!id || toolCalls.has(id) || call.status !== "success") continue;
      const at = Date.parse(str(call.timestamp)) || ts;
      if (sinceMs !== null && at <= sinceMs) continue;
      toolCalls.add(id);
      seen(at);
      if (!EDIT_TOOLS.has(str(call.name))) continue;
      const args = call.args ?? {};
      const path =
        str(args.file_path) || str(args.absolute_path) || str(args.path);
      if (!path) continue;
      const stat = call.resultDisplay?.diffStat ?? null;
      const added = n(stat?.model_added_lines);
      const removed = n(stat?.model_removed_lines);
      edits.push({
        path,
        timestamp: new Date(at).toISOString(),
        lineChanges: added - removed,
        linesAdded: added,
        linesRemoved: removed,
        cwd,
      });
    }
  }

  const state: GeminiState = {
    sessionId,
    messages: Object.fromEntries([...messages].slice(-KEEP_IDS)),
    toolCalls: [...toolCalls].slice(-KEEP_IDS),
  };
  if (!sessionId) return { session: null, state };
  return {
    session: {
      tool: "gemini-cli",
      id: sessionId,
      cwd,
      model,
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
