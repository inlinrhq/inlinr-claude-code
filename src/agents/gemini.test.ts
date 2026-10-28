import { describe, expect, test } from "bun:test";
import { parseGemini } from "./gemini";

const j = (o: unknown) => JSON.stringify(o);

const META = j({
  sessionId: "g-1",
  projectHash: "abc",
  startTime: "2026-10-01T10:00:00.000Z",
  lastUpdated: "2026-10-01T10:00:00.000Z",
});

const user = (id: string, at: string) =>
  j({ id, timestamp: at, type: "user", content: [{ text: "hi" }] });

const gemini = (id: string, at: string, extra: Record<string, unknown> = {}) =>
  j({
    id,
    timestamp: at,
    type: "gemini",
    content: "",
    model: "gemini-3.1-pro-preview",
    ...extra,
  });

const tokens = { input: 1000, cached: 600, output: 40, thoughts: 10, total: 1050 };

const edit = (id: string, at: string, status = "success") => ({
  id,
  name: "replace",
  args: { file_path: "/repo/src/a.ts" },
  status,
  timestamp: at,
  resultDisplay: {
    diffStat: { model_added_lines: 3, model_removed_lines: 1, user_added_lines: 9 },
  },
});

describe("parseGemini", () => {
  test("reads the session, its model and its folder", () => {
    const { session } = parseGemini(
      [META, user("u1", "2026-10-01T10:00:01.000Z")].join("\n"),
      { root: "/repo" },
    );
    expect(session?.tool).toBe("gemini-cli");
    expect(session?.id).toBe("g-1");
    expect(session?.cwd).toBe("/repo");
  });

  test("counts a message's tokens once, however often it is rewritten", () => {
    const { session } = parseGemini(
      [
        META,
        gemini("m1", "2026-10-01T10:00:02.000Z"),
        gemini("m1", "2026-10-01T10:00:02.000Z", { tokens }),
        gemini("m1", "2026-10-01T10:00:02.000Z", { tokens, toolCalls: [] }),
      ].join("\n"),
    );
    expect(session?.tokens).toEqual({
      input: 400,
      cacheRead: 600,
      cacheWrite: 0,
      output: 50,
    });
    expect(session?.model).toBe("gemini-3.1-pro-preview");
  });

  test("counts an edit once it succeeded, with the model's lines", () => {
    const { session } = parseGemini(
      [
        META,
        gemini("m1", "2026-10-01T10:00:02.000Z", {
          toolCalls: [edit("t1", "2026-10-01T10:00:05.000Z", "executing")],
        }),
        gemini("m1", "2026-10-01T10:00:02.000Z", {
          toolCalls: [edit("t1", "2026-10-01T10:00:05.000Z")],
        }),
        gemini("m1", "2026-10-01T10:00:02.000Z", {
          toolCalls: [edit("t1", "2026-10-01T10:00:05.000Z")],
        }),
      ].join("\n"),
    );
    expect(session?.edits).toEqual([
      {
        path: "/repo/src/a.ts",
        timestamp: "2026-10-01T10:00:05.000Z",
        lineChanges: 2,
        linesAdded: 3,
        linesRemoved: 1,
        cwd: "",
      },
    ]);
  });

  test("carries what it counted to the next read", () => {
    const first = parseGemini(
      [
        META,
        gemini("m1", "2026-10-01T10:00:02.000Z", {
          tokens,
          toolCalls: [edit("t1", "2026-10-01T10:00:05.000Z")],
        }),
      ].join("\n"),
    );
    const second = parseGemini(
      gemini("m1", "2026-10-01T10:00:02.000Z", {
        tokens: { ...tokens, output: 60 },
        toolCalls: [edit("t1", "2026-10-01T10:00:05.000Z")],
      }),
      { state: JSON.parse(JSON.stringify(first.state)) },
    );
    expect(second.session?.id).toBe("g-1");
    expect(second.session?.edits).toEqual([]);
    expect(second.session?.tokens.output).toBe(20);
    expect(second.session?.tokens.input).toBe(0);
  });

  test("skips what happened before tracking began", () => {
    const { session } = parseGemini(
      [
        META,
        gemini("m1", "2026-10-01T10:00:02.000Z", { tokens }),
        gemini("m2", "2026-10-01T11:00:00.000Z", {
          tokens: { input: 10, output: 5 },
        }),
      ].join("\n"),
      { since: new Date("2026-10-01T10:30:00.000Z") },
    );
    expect(session?.tokens.input).toBe(10);
    expect(session?.activity.map((a) => a.at)).toEqual([
      "2026-10-01T11:00:00.000Z",
    ]);
  });
});
