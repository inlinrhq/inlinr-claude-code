import { describe, expect, test } from "bun:test";
import { codexTokens, parseCodex, parsePatch } from "./codex";

const line = (timestamp: string, type: string, payload: unknown) =>
  JSON.stringify({ timestamp, type, payload });

const meta = (at = "2026-10-01T10:00:00.000Z", extra = {}) =>
  line(at, "session_meta", {
    id: "thread-1",
    timestamp: at,
    cwd: "/repo",
    originator: "codex_cli_rs",
    cli_version: "0.140.0",
    ...extra,
  });

const turn = (at: string, cwd = "/repo", model = "gpt-5.5-codex") =>
  line(at, "turn_context", { cwd, model });

const tokenCount = (
  at: string,
  last: Record<string, number>,
  total: number,
) =>
  line(at, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: last,
    },
  });

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  " keep",
  "-old",
  "+new",
  "+more",
  "*** Add File: /abs/b.ts",
  "+one",
  "+two",
  "*** End Patch",
].join("\n");

const patchCall = (at: string, id = "call_1", input = PATCH) =>
  line(at, "response_item", {
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: id,
    input,
  });

const patchOutput = (at: string, id = "call_1", output = "Success. Updated the following files:\nM src/a.ts") =>
  line(at, "response_item", {
    type: "custom_tool_call_output",
    call_id: id,
    output,
  });

describe("parsePatch", () => {
  test("counts each file's lines, relative paths from the folder", () => {
    expect(parsePatch(PATCH, "/repo")).toEqual([
      { path: "/repo/src/a.ts", added: 2, removed: 1 },
      { path: "/abs/b.ts", added: 2, removed: 0 },
    ]);
  });

  test("follows a move", () => {
    const moved = [
      "*** Update File: a.ts",
      "*** Move to: b.ts",
      "+x",
    ].join("\n");
    expect(parsePatch(moved, "/r")).toEqual([
      { path: "/r/b.ts", added: 1, removed: 0 },
    ]);
  });
});

describe("codexTokens", () => {
  test("takes cached input out of input", () => {
    expect(
      codexTokens({
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 50,
      }),
    ).toEqual({ input: 200, cacheRead: 800, cacheWrite: 0, output: 50 });
  });
});

describe("parseCodex", () => {
  test("reads the session, its model and its folder", () => {
    const { session } = parseCodex(
      [meta(), turn("2026-10-01T10:00:01.000Z")].join("\n"),
    );
    expect(session?.tool).toBe("codex");
    expect(session?.id).toBe("thread-1");
    expect(session?.cwd).toBe("/repo");
    expect(session?.model).toBe("gpt-5.5-codex");
  });

  test("counts a token_count once, even when it is emitted again", () => {
    const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
    const { session } = parseCodex(
      [
        meta(),
        tokenCount("2026-10-01T10:00:05.000Z", usage, 110),
        tokenCount("2026-10-01T10:00:06.000Z", usage, 110),
        tokenCount("2026-10-01T10:01:00.000Z", usage, 220),
      ].join("\n"),
    );
    expect(session?.tokens).toEqual({
      input: 120,
      cacheRead: 80,
      cacheWrite: 0,
      output: 20,
    });
  });

  test("counts per-response records alone once the file has them", () => {
    const { session } = parseCodex(
      [
        meta(),
        tokenCount("2026-10-01T10:00:05.000Z", { input_tokens: 999 }, 999),
        line("2026-10-01T10:00:06.000Z", "token_usage_record", {
          response_id: "r1",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        tokenCount("2026-10-01T10:00:07.000Z", { input_tokens: 777 }, 1776),
      ].join("\n"),
    );
    expect(session?.tokens.input).toBe(999 + 10);
    expect(session?.tokens.output).toBe(5);
  });

  test("counts a patch once its output says it applied", () => {
    const { session } = parseCodex(
      [
        meta(),
        patchCall("2026-10-01T10:00:10.000Z"),
        patchOutput("2026-10-01T10:00:11.000Z"),
      ].join("\n"),
    );
    expect(session?.edits.map((e) => [e.path, e.linesAdded, e.linesRemoved])).toEqual([
      ["/repo/src/a.ts", 2, 1],
      ["/abs/b.ts", 2, 0],
    ]);
  });

  test("drops a rejected patch", () => {
    const { session } = parseCodex(
      [
        meta(),
        patchCall("2026-10-01T10:00:10.000Z"),
        patchOutput("2026-10-01T10:00:11.000Z", "call_1", "apply_patch verification failed"),
      ].join("\n"),
    );
    expect(session?.edits).toEqual([]);
  });

  test("carries the session and a pending patch to the next read", () => {
    const first = parseCodex(
      [meta(), turn("2026-10-01T10:00:01.000Z"), patchCall("2026-10-01T10:00:10.000Z")].join("\n"),
    );
    expect(first.session?.edits).toEqual([]);
    const second = parseCodex(patchOutput("2026-10-01T10:00:11.000Z"), {
      state: JSON.parse(JSON.stringify(first.state)),
    });
    expect(second.session?.id).toBe("thread-1");
    expect(second.session?.model).toBe("gpt-5.5-codex");
    expect(second.session?.edits).toHaveLength(2);
  });

  test("skips a fork's replay of its parent", () => {
    const { session } = parseCodex(
      [
        meta("2026-10-02T09:00:00.000Z", { forked_from_id: "thread-0" }),
        tokenCount("2026-10-01T10:00:05.000Z", { output_tokens: 50 }, 50),
        tokenCount("2026-10-02T09:01:00.000Z", { output_tokens: 7 }, 57),
      ].join("\n"),
    );
    expect(session?.tokens.output).toBe(7);
  });

  test("skips what happened before tracking began", () => {
    const { session } = parseCodex(
      [
        meta(),
        tokenCount("2026-10-01T10:00:05.000Z", { output_tokens: 50 }, 50),
        tokenCount("2026-10-01T11:00:00.000Z", { output_tokens: 7 }, 57),
      ].join("\n"),
      { since: new Date("2026-10-01T10:30:00.000Z") },
    );
    expect(session?.tokens.output).toBe(7);
  });

  test("turns each tool call and message into activity", () => {
    const { session } = parseCodex(
      [
        meta(),
        line("2026-10-01T10:00:02.000Z", "response_item", {
          type: "message",
          role: "user",
        }),
        line("2026-10-01T10:00:30.000Z", "event_msg", { type: "agent_message" }),
      ].join("\n"),
    );
    expect(session?.activity.map((a) => a.at)).toEqual([
      "2026-10-01T10:00:02.000Z",
      "2026-10-01T10:00:30.000Z",
    ]);
  });
});
