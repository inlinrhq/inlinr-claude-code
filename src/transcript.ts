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
};

export type Session = {
	id: string;
	cwd: string;
	model: string;
	tokens: Tokens;
	edits: FileEdit[];
	firstSeen: string | null;
	lastSeen: string | null;
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

/** What one message id has contributed so far, so it can be superseded. */
type Contribution = { input: number; cacheRead: number; cacheWrite: number; output: number };

/**
 * Parse one transcript file's lines into a session.
 *
 * `since` skips entries at or before a watermark so a re-read costs nothing.
 * Lines that do not parse are skipped rather than aborting the file: a
 * transcript being appended to while we read it will have a partial last line,
 * and that is normal rather than exceptional.
 */
export function parseTranscript(
	content: string,
	since: Date | null = null,
): Session | null {
	const sinceMs = since ? since.getTime() : null;

	let id = "";
	let cwd = "";
	let model = "";
	const tokens = emptyTokens();
	const edits: FileEdit[] = [];
	let firstSeen: number | null = null;
	let lastSeen: number | null = null;

	// Keyed by message id. Only the newest totals for an id count.
	const seen = new Map<string, Contribution>();

	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		// A subagent's work is already in its parent session's file, flagged.
		// Counting it again doubles both tokens and edits.
		if (entry.isSidechain === true) continue;

		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (Number.isNaN(ts)) continue;

		if (typeof entry.sessionId === "string" && entry.sessionId) id = entry.sessionId;
		if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;

		if (sinceMs !== null && ts <= sinceMs) continue;

		if (firstSeen === null || ts < firstSeen) firstSeen = ts;
		if (lastSeen === null || ts > lastSeen) lastSeen = ts;

		const message = entry.message as
			| { id?: unknown; model?: unknown; usage?: Usage }
			| undefined;
		if (message && typeof message.model === "string" && message.model) {
			model = message.model;
		}

		const usage = (message?.usage ?? (entry.usage as Usage | undefined)) ?? null;
		if (usage) {
			const next: Contribution = {
				input: n(usage.input_tokens),
				cacheRead: n(usage.cache_read_input_tokens),
				cacheWrite: n(usage.cache_creation_input_tokens),
				output: n(usage.output_tokens),
			};
			const key = typeof message?.id === "string" && message.id ? message.id : "";
			if (key) {
				const before = seen.get(key);
				if (before) {
					// Supersede rather than add. See the note at the top.
					tokens.input += next.input - before.input;
					tokens.cacheRead += next.cacheRead - before.cacheRead;
					tokens.cacheWrite += next.cacheWrite - before.cacheWrite;
					tokens.output += next.output - before.output;
				} else {
					tokens.input += next.input;
					tokens.cacheRead += next.cacheRead;
					tokens.cacheWrite += next.cacheWrite;
					tokens.output += next.output;
				}
				seen.set(key, next);
			} else {
				// No id to key on. Counting it once is the only safe choice —
				// dropping it loses real usage, and de-duplicating without a key
				// would drop distinct messages that happen to match.
				tokens.input += next.input;
				tokens.cacheRead += next.cacheRead;
				tokens.cacheWrite += next.cacheWrite;
				tokens.output += next.output;
			}
		}

		const result = entry.toolUseResult as
			| {
					filePath?: unknown;
					structuredPatch?: Array<{ newLines?: unknown; oldLines?: unknown }>;
			  }
			| undefined;
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
				timestamp: new Date(ts).toISOString(),
				lineChanges: added - removed,
				linesAdded: added,
				linesRemoved: removed,
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
		firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
		lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
	};
}

/** Nothing new since the watermark. */
export function isEmpty(session: Session): boolean {
	return (
		session.edits.length === 0 &&
		session.tokens.input === 0 &&
		session.tokens.output === 0 &&
		session.tokens.cacheRead === 0 &&
		session.tokens.cacheWrite === 0
	);
}
