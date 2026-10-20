/**
 * Reading Claude Code's own transcripts.
 *
 * Claude Code writes one JSONL file per session under
 * `~/.claude/projects/<slug>/<session-uuid>.jsonl`, and that file is the only
 * place token usage exists — it is never sent anywhere else. Everything this
 * plugin reports comes from parsing it.
 *
 * Two things here are subtle enough that getting them wrong is silent:
 *
 * **Token totals are running, not incremental.** The same message id is logged
 * several times while a response streams, each carrying the totals so far.
 * Summing the lines multiplies a response's cost by the number of chunks, so
 * the previous contribution for that id is subtracted before the new one is
 * added.
 *
 * **Cache tokens are kept apart from input.** They bill at very different
 * rates — reads well below the input rate, writes above it — and collapsing
 * them into one number priced at the input rate overstates a long session by
 * close to an order of magnitude, because most of a Claude Code turn is
 * re-read context.
 */

export type Tokens = {
  /** Fresh input, billed at the full input rate. */
  input: number;
  /** Context re-read from the prompt cache. */
  cacheRead: number;
  /** Context written to the prompt cache. */
  cacheWrite: number;
  output: number;
};

export type FileEdit = {
  path: string;
  timestamp: string;
  /** Net delta: positive when the assistant added more than it removed. */
  lineChanges: number;
  linesAdded: number;
  linesRemoved: number;
  /** Where the session stood when it made the edit. */
  cwd: string;
};

/**
 * A moment the session was doing something: a prompt, a response, a tool
 * result.
 *
 * This is what time is made of. Duration is computed from the gaps between
 * beats, and a session that only produced beats on file edits looked idle
 * through everything else — reading code, running tests, a long answer, a
 * subagent at work. Twenty minutes of investigation before a one-line fix
 * showed up as nothing, because the gap before the fix was over the timeout.
 */
export type Activity = {
  at: string;
  cwd: string;
};

/**
 * What the last message id contributed, carried from one sync to the next.
 *
 * Lines for one streaming message are consecutive, but a sync can land
 * between two of them. Without the carry, the next sync would see the id for
 * the first time and add its totals on top of what was already sent.
 */
export type Carry = { id: string } & Tokens;

export type Session = {
  id: string;
  /** The newest working directory seen. */
  cwd: string;
  model: string;
  tokens: Tokens;
  edits: FileEdit[];
  activity: Activity[];
  firstSeen: string | null;
  lastSeen: string | null;
  carry: Carry | null;
};

export const emptyTokens = (): Tokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
});

type Usage = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
};

const n = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

export type ParseOptions = {
  /** Skip entries at or before this instant. */
  since?: Date | null;
  /** The last message of the previous read of this file. */
  carry?: Carry | null;
  /**
   * A subagent's own file. Every line in it is flagged `isSidechain`, and
   * those lines exist nowhere else — the parent file only holds the call
   * and the final answer. Skipping them lost the subagent's time, tokens
   * and edits entirely.
   */
  subagent?: boolean;
};

/**
 * Parse transcript lines into a session.
 *
 * Lines that do not parse are skipped rather than aborting the file: a
 * transcript being appended to while we read it will have a partial last line,
 * and that is normal rather than exceptional.
 */
export function parseTranscript(
  content: string,
  options: ParseOptions = {},
): Session | null {
  const sinceMs = options.since ? options.since.getTime() : null;

  let id = "";
  let cwd = "";
  let model = "";
  const tokens = emptyTokens();
  const edits: FileEdit[] = [];
  const activity: Activity[] = [];
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  // Keyed by message id. Only the newest totals for an id count. Lines of
  // one message are consecutive, so only the last one needs to survive to
  // the next sync.
  let carry: Carry | null = options.carry ?? null;
  const seen = new Map<string, Tokens>();
  if (carry) seen.set(carry.id, carry);

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // In the main file, a sidechain line is a subagent's work logged by
    // an older Claude Code alongside the parent's. Current versions write
    // it to the subagent's own file, which is read on its own.
    if (entry.isSidechain === true && !options.subagent) continue;

    const ts =
      typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : Number.NaN;
    if (Number.isNaN(ts)) continue;

    if (typeof entry.sessionId === "string" && entry.sessionId)
      id = entry.sessionId;
    if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;

    if (sinceMs !== null && ts <= sinceMs) continue;

    const message = entry.message as
      | { id?: unknown; model?: unknown; usage?: Usage }
      | undefined;
    const result = entry.toolUseResult as
      | {
          filePath?: unknown;
          structuredPatch?: Array<{ newLines?: unknown; oldLines?: unknown }>;
        }
      | undefined;

    // Only conversation lines are activity. Bookkeeping lines (queue
    // operations, attachments, summaries) carry timestamps too, but they
    // are written by Claude Code, not by anyone working.
    if (!message && !result) continue;

    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;
    const at = new Date(ts).toISOString();
    activity.push({ at, cwd });

    if (message && typeof message.model === "string" && message.model) {
      model = message.model;
    }

    const usage = message?.usage ?? (entry.usage as Usage | undefined) ?? null;
    if (usage) {
      const next: Tokens = {
        input: n(usage.input_tokens),
        cacheRead: n(usage.cache_read_input_tokens),
        cacheWrite: n(usage.cache_creation_input_tokens),
        output: n(usage.output_tokens),
      };
      const key =
        typeof message?.id === "string" && message.id ? message.id : "";
      // Supersede rather than add. See the note at the top.
      const before = (key && seen.get(key)) || emptyTokens();
      tokens.input += next.input - before.input;
      tokens.cacheRead += next.cacheRead - before.cacheRead;
      tokens.cacheWrite += next.cacheWrite - before.cacheWrite;
      tokens.output += next.output - before.output;
      // No id to key on: counted once, and nothing to supersede later.
      if (key) seen.set(key, next);
      carry = key ? { id: key, ...next } : null;
    }

    if (result && typeof result.filePath === "string" && result.filePath) {
      const patch = Array.isArray(result.structuredPatch)
        ? result.structuredPatch
        : [];
      let added = 0;
      let removed = 0;
      for (const hunk of patch) {
        added += n(hunk.newLines);
        removed += n(hunk.oldLines);
      }
      // A write with no patch is still an edit; it just has no measurable
      // line delta. Recording it keeps "files touched" honest.
      edits.push({
        path: result.filePath,
        timestamp: at,
        lineChanges: added - removed,
        linesAdded: added,
        linesRemoved: removed,
        cwd,
      });
    }
  }

  if (!id) return null;

  return {
    id,
    cwd,
    model,
    tokens,
    edits,
    activity,
    firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    carry,
  };
}

/** Nothing new since the watermark. */
export function isEmpty(session: Session): boolean {
  return (
    session.edits.length === 0 &&
    session.activity.length === 0 &&
    session.tokens.input === 0 &&
    session.tokens.output === 0 &&
    session.tokens.cacheRead === 0 &&
    session.tokens.cacheWrite === 0
  );
}
