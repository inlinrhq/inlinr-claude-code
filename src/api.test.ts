import { describe, expect, test } from "bun:test";
import { coalesceEdits, MAX_BATCH, toHeartbeats } from "./api";
import type { Session } from "./transcript";

const edit = (path: string, at: string, added = 5, removed = 2) => ({
	path,
	timestamp: at,
	linesAdded: added,
	linesRemoved: removed,
	lineChanges: added - removed,
});

const session = (over: Partial<Session> = {}): Session => ({
	id: "s1",
	cwd: "/repo",
	model: "claude-opus-5",
	tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
	edits: [],
	firstSeen: "2026-08-01T10:00:00.000Z",
	lastSeen: "2026-08-01T10:05:00.000Z",
	...over,
});

describe("coalesceEdits", () => {
	test("merges edits to one file inside a window", () => {
		// Twenty rows for twenty edits in a minute is storage and query cost for
		// no extra information: duration comes from the gaps between beats, and
		// second-long gaps sum to the same time one beat does.
		const out = coalesceEdits([
			edit("/a.ts", "2026-08-01T10:00:00Z", 3, 1),
			edit("/a.ts", "2026-08-01T10:00:30Z", 4, 2),
			edit("/a.ts", "2026-08-01T10:01:00Z", 5, 0),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ linesAdded: 12, linesRemoved: 3 });
	});

	test("keeps different files apart", () => {
		const out = coalesceEdits([
			edit("/a.ts", "2026-08-01T10:00:00Z"),
			edit("/b.ts", "2026-08-01T10:00:10Z"),
		]);
		expect(out).toHaveLength(2);
	});

	test("keeps windows apart, so long work is not one beat", () => {
		// Collapsing an hour into one beat would leave a gap larger than any
		// keystroke timeout and drop the time on the floor.
		const out = coalesceEdits([
			edit("/a.ts", "2026-08-01T10:00:00Z"),
			edit("/a.ts", "2026-08-01T11:00:00Z"),
		]);
		expect(out).toHaveLength(2);
	});

	test("stamps the bucket at its latest edit", () => {
		const out = coalesceEdits([
			edit("/a.ts", "2026-08-01T10:00:00Z"),
			edit("/a.ts", "2026-08-01T10:00:45Z"),
		]);
		expect(out[0]?.timestamp).toBe("2026-08-01T10:00:45Z");
	});

	test("returns beats in time order", () => {
		const out = coalesceEdits([
			edit("/b.ts", "2026-08-01T12:00:00Z"),
			edit("/a.ts", "2026-08-01T10:00:00Z"),
		]);
		expect(out.map((e) => e.path)).toEqual(["/a.ts", "/b.ts"]);
	});

	test("drops edits with an unusable timestamp rather than bucketing NaN", () => {
		const out = coalesceEdits([edit("/a.ts", "not-a-date")]);
		expect(out).toEqual([]);
	});
});

describe("toHeartbeats", () => {
	test("sends one file beat per window, not per edit", () => {
		const s = session({
			edits: [
				edit("/a.ts", "2026-08-01T10:00:00Z"),
				edit("/a.ts", "2026-08-01T10:00:20Z"),
			],
		});
		const beats = toHeartbeats(s, "git@github.com:a/b.git", "0.1.0");
		expect(beats.filter((b) => b.type === "file")).toHaveLength(1);
	});

	test("carries the assistant's own line attribution", () => {
		// The field the dashboard needs to say what share of the code an
		// assistant wrote, and the one that was never populated before.
		const s = session({ edits: [edit("/a.ts", "2026-08-01T10:00:00Z", 9, 4)] });
		const [b] = toHeartbeats(s, "git@github.com:a/b.git", "0.1.0");
		expect(b).toMatchObject({ ai_lines_added: 9, ai_lines_deleted: 4 });
	});

	test("adds one app beat for the session's tokens", () => {
		const s = session({
			tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 },
		});
		const beats = toHeartbeats(s, "git@github.com:a/b.git", "0.1.0");
		const app = beats.filter((b) => b.type === "app");
		expect(app).toHaveLength(1);
		expect(app[0]).toMatchObject({
			ai_input_tokens: 100,
			ai_cache_read_tokens: 20,
			ai_output_tokens: 50,
		});
	});

	test("sends no token beat when there were no tokens", () => {
		const beats = toHeartbeats(session(), "git@github.com:a/b.git", "0.1.0");
		expect(beats).toHaveLength(0);
	});

	test("omits the project when there is no remote, rather than sending an empty one", () => {
		// The caller skips these sessions entirely; this only guarantees that if
		// one ever gets through, it does not carry a blank project key that
		// ingest would have to interpret.
		const s = session({ edits: [edit("/a.ts", "2026-08-01T10:00:00Z")] });
		const [b] = toHeartbeats(s, "", "0.1.0");
		expect(b?.project_git_remote).toBeUndefined();
	});
});

describe("MAX_BATCH", () => {
	test("matches the server's own limit", () => {
		// The ingest schema is z.array(...).max(1000). Sending more is a 400,
		// not a slow request — which is exactly how a whole sync failed
		// silently.
		expect(MAX_BATCH).toBe(1000);
	});
});
