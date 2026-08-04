import { describe, expect, test } from "bun:test";
import { isEmpty, parseTranscript } from "./transcript";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

const usageLine = (
	id: string,
	at: string,
	usage: Record<string, number>,
	extra: Record<string, unknown> = {},
) =>
	line({
		timestamp: at,
		sessionId: "s1",
		cwd: "/repo",
		message: { id, role: "assistant", model: "claude-opus-5", usage },
		...extra,
	});

describe("parseTranscript", () => {
	test("reads session id, cwd and model", () => {
		const s = parseTranscript(
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
		);
		expect(s?.id).toBe("s1");
		expect(s?.cwd).toBe("/repo");
		expect(s?.model).toBe("claude-opus-5");
	});

	test("supersedes a streaming message instead of adding it up", () => {
		// This is the one that silently multiplies a response's cost by the
		// number of chunks if it is wrong.
		const content = [
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
			usageLine("m1", "2026-08-01T10:00:01Z", { output_tokens: 25 }),
			usageLine("m1", "2026-08-01T10:00:02Z", { output_tokens: 40 }),
		].join("\n");
		expect(parseTranscript(content)?.tokens.output).toBe(40);
	});

	test("still adds up genuinely distinct messages", () => {
		const content = [
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 40 }),
			usageLine("m2", "2026-08-01T10:01:00Z", { output_tokens: 15 }),
		].join("\n");
		expect(parseTranscript(content)?.tokens.output).toBe(55);
	});

	test("keeps cache tokens apart from input", () => {
		// They bill at very different rates; collapsing them overstates a long
		// session by close to an order of magnitude.
		const s = parseTranscript(
			usageLine("m1", "2026-08-01T10:00:00Z", {
				input_tokens: 100,
				cache_read_input_tokens: 9000,
				cache_creation_input_tokens: 500,
				output_tokens: 20,
			}),
		);
		expect(s?.tokens).toEqual({
			input: 100,
			cacheRead: 9000,
			cacheWrite: 500,
			output: 20,
		});
	});

	test("ignores subagent lines", () => {
		// Their work is already in the parent's own file; counting it again
		// doubles both tokens and edits.
		const content = [
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
			usageLine("m2", "2026-08-01T10:00:05Z", { output_tokens: 999 }, {
				isSidechain: true,
			}),
		].join("\n");
		expect(parseTranscript(content)?.tokens.output).toBe(10);
	});

	test("collects file edits with their line deltas", () => {
		const content = line({
			timestamp: "2026-08-01T10:00:00Z",
			sessionId: "s1",
			cwd: "/repo",
			toolUseResult: {
				filePath: "/repo/src/a.ts",
				structuredPatch: [
					{ newLines: 10, oldLines: 4 },
					{ newLines: 3, oldLines: 1 },
				],
			},
		});
		const s = parseTranscript(content);
		expect(s?.edits).toHaveLength(1);
		expect(s?.edits[0]).toMatchObject({
			path: "/repo/src/a.ts",
			linesAdded: 13,
			linesRemoved: 5,
			lineChanges: 8,
		});
	});

	test("records a write with no patch as an edit with no delta", () => {
		// A new file has no hunks. Dropping it would understate files touched.
		const s = parseTranscript(
			line({
				timestamp: "2026-08-01T10:00:00Z",
				sessionId: "s1",
				toolUseResult: { filePath: "/repo/new.ts" },
			}),
		);
		expect(s?.edits).toHaveLength(1);
		expect(s?.edits[0]?.lineChanges).toBe(0);
	});

	test("skips everything at or before the watermark", () => {
		const content = [
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
			usageLine("m2", "2026-08-01T11:00:00Z", { output_tokens: 20 }),
		].join("\n");
		const s = parseTranscript(content, new Date("2026-08-01T10:30:00Z"));
		expect(s?.tokens.output).toBe(20);
		// The session identity still comes through, because it is read before
		// the watermark check — otherwise a resumed session would look new.
		expect(s?.id).toBe("s1");
		expect(s?.cwd).toBe("/repo");
	});

	test("survives a partial last line", () => {
		// Normal: the file is being appended to while we read it.
		const content = `${usageLine("m1", "2026-08-01T10:00:00Z", {
			output_tokens: 10,
		})}\n{"timestamp":"2026-08-01T10`;
		expect(parseTranscript(content)?.tokens.output).toBe(10);
	});

	test("skips lines with no usable timestamp", () => {
		const content = [
			line({ sessionId: "s1", message: { id: "x", usage: { output_tokens: 5 } } }),
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
		].join("\n");
		expect(parseTranscript(content)?.tokens.output).toBe(10);
	});

	test("treats negative and non-numeric counts as zero", () => {
		const s = parseTranscript(
			usageLine("m1", "2026-08-01T10:00:00Z", {
				output_tokens: -5 as unknown as number,
			}),
		);
		expect(s?.tokens.output).toBe(0);
	});

	test("returns null when there is no session id at all", () => {
		expect(parseTranscript("")).toBeNull();
		expect(parseTranscript(line({ timestamp: "2026-08-01T10:00:00Z" }))).toBeNull();
	});

	test("brackets the session with first and last seen", () => {
		const content = [
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 1 }),
			usageLine("m2", "2026-08-01T12:30:00Z", { output_tokens: 1 }),
		].join("\n");
		const s = parseTranscript(content);
		expect(s?.firstSeen).toBe("2026-08-01T10:00:00.000Z");
		expect(s?.lastSeen).toBe("2026-08-01T12:30:00.000Z");
	});
});

describe("isEmpty", () => {
	test("is true when the watermark left nothing", () => {
		const s = parseTranscript(
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
			new Date("2026-08-02T00:00:00Z"),
		);
		expect(s && isEmpty(s)).toBe(true);
	});

	test("is false when anything at all came through", () => {
		const s = parseTranscript(
			usageLine("m1", "2026-08-01T10:00:00Z", { output_tokens: 10 }),
		);
		expect(s && isEmpty(s)).toBe(false);
	});
});
