import { describe, expect, test } from "bun:test";
import { coalesceEdits, MAX_BATCH, type Repo, toHeartbeats } from "./api";
import type { Session } from "./transcript";

const edit = (path: string, at: string, added = 5, removed = 2, cwd = "/repo") => ({
	path,
	timestamp: at,
	linesAdded: added,
	linesRemoved: removed,
	lineChanges: added - removed,
	cwd,
});

const act = (at: string, cwd = "/repo") => ({ at, cwd });

/** `/repo` and `/other` are repositories; `/work`, their parent, is not. */
const resolve = (dir: string): Repo | null => {
	for (const root of ["/repo", "/other"]) {
		if (dir === root || dir.startsWith(`${root}/`)) {
			return { root, remote: `git@github.com:a${root}.git`, branch: root === "/repo" ? "main" : "" };
		}
	}
	return null;
};

const session = (over: Partial<Session> = {}): Session => ({
	id: "s1",
	cwd: "/repo",
	model: "claude-opus-5",
	tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
	edits: [],
	activity: [],
	carry: null,
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
			edit("/repo/a.ts", "2026-08-01T10:00:00Z", 3, 1),
			edit("/repo/a.ts", "2026-08-01T10:00:30Z", 4, 2),
			edit("/repo/a.ts", "2026-08-01T10:01:00Z", 5, 0),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ linesAdded: 12, linesRemoved: 3 });
	});

	test("keeps different files apart", () => {
		const out = coalesceEdits([
			edit("/repo/a.ts", "2026-08-01T10:00:00Z"),
			edit("/repo/b.ts", "2026-08-01T10:00:10Z"),
		]);
		expect(out).toHaveLength(2);
	});

	test("keeps windows apart, so long work is not one beat", () => {
		// Collapsing an hour into one beat would leave a gap larger than any
		// keystroke timeout and drop the time on the floor.
		const out = coalesceEdits([
			edit("/repo/a.ts", "2026-08-01T10:00:00Z"),
			edit("/repo/a.ts", "2026-08-01T11:00:00Z"),
		]);
		expect(out).toHaveLength(2);
	});

	test("stamps the bucket at its latest edit", () => {
		const out = coalesceEdits([
			edit("/repo/a.ts", "2026-08-01T10:00:00Z"),
			edit("/repo/a.ts", "2026-08-01T10:00:45Z"),
		]);
		expect(out[0]?.timestamp).toBe("2026-08-01T10:00:45Z");
	});

	test("returns beats in time order", () => {
		const out = coalesceEdits([
			edit("/repo/b.ts", "2026-08-01T12:00:00Z"),
			edit("/repo/a.ts", "2026-08-01T10:00:00Z"),
		]);
		expect(out.map((e) => e.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
	});

	test("drops edits with an unusable timestamp rather than bucketing NaN", () => {
		const out = coalesceEdits([edit("/repo/a.ts", "not-a-date")]);
		expect(out).toEqual([]);
	});
});

describe("toHeartbeats", () => {
	test("sends one file beat per window, not per edit", () => {
		const s = session({
			edits: [
				edit("/repo/a.ts", "2026-08-01T10:00:00Z"),
				edit("/repo/a.ts", "2026-08-01T10:00:20Z"),
			],
		});
		const beats = toHeartbeats(s, resolve, "0.1.0");
		expect(beats.filter((b) => b.type === "file")).toHaveLength(1);
	});

	test("carries the assistant's own line attribution", () => {
		// The field the dashboard needs to say what share of the code an
		// assistant wrote, and the one that was never populated before.
		const s = session({ edits: [edit("/repo/a.ts", "2026-08-01T10:00:00Z", 9, 4)] });
		const [b] = toHeartbeats(s, resolve, "0.1.0");
		expect(b).toMatchObject({ ai_lines_added: 9, ai_lines_deleted: 4 });
	});

	test("puts the session's tokens on its last activity beat", () => {
		const s = session({
			tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 },
			activity: [act("2026-08-01T10:00:00Z"), act("2026-08-01T10:03:00Z")],
		});
		const app = toHeartbeats(s, resolve, "0.1.0").filter((b) => b.type === "app");
		expect(app).toHaveLength(2);
		expect(app[0]?.ai_output_tokens).toBeUndefined();
		expect(app[1]).toMatchObject({
			ai_input_tokens: 100,
			ai_cache_read_tokens: 20,
			ai_output_tokens: 50,
		});
	});

	test("sends a beat for every minute of activity, not only for edits", () => {
		// The bug: twenty minutes of reading and running things before a
		// one-line fix showed up as no time at all.
		const s = session({
			activity: [
				act("2026-08-01T10:00:00Z"),
				act("2026-08-01T10:00:20Z"),
				act("2026-08-01T10:00:40Z"),
				act("2026-08-01T10:06:00Z"),
				act("2026-08-01T10:12:00Z"),
			],
		});
		const app = toHeartbeats(s, resolve, "0.1.0");
		expect(app.map((b) => new Date(b.time * 1000).toISOString())).toEqual([
			"2026-08-01T10:00:40.000Z",
			"2026-08-01T10:06:00.000Z",
			"2026-08-01T10:12:00.000Z",
		]);
		expect(app[0]).toMatchObject({ type: "app", category: "ai", branch: "main" });
	});

	test("attributes an edit to the repository its file is in", () => {
		const s = session({ edits: [edit("/other/x.ts", "2026-08-01T10:00:00Z")] });
		const [b] = toHeartbeats(s, resolve, "0.1.0");
		expect(b?.project_git_remote).toBe("git@github.com:a/other.git");
		expect(b?.branch).toBeUndefined();
	});

	test("gives activity in a folder of repositories to the one being edited", () => {
		// A session started in the parent folder of several repositories has
		// no remote of its own. It used to be dropped whole.
		const s = session({
			cwd: "/work",
			edits: [edit("/other/x.ts", "2026-08-01T10:05:00Z", 1, 0, "/work")],
			activity: [act("2026-08-01T10:00:00Z", "/work"), act("2026-08-01T10:05:00Z", "/work")],
		});
		const beats = toHeartbeats(s, resolve, "0.1.0");
		expect(beats.length).toBe(3);
		for (const b of beats) {
			expect(b.project_git_remote).toBe("git@github.com:a/other.git");
		}
	});

	test("drops what cannot be attributed to any repository", () => {
		const s = session({
			cwd: "/tmp",
			edits: [edit("/tmp/x.ts", "2026-08-01T10:00:00Z", 1, 0, "/tmp")],
			activity: [act("2026-08-01T10:00:00Z", "/tmp")],
		});
		expect(toHeartbeats(s, resolve, "0.1.0")).toHaveLength(0);
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
