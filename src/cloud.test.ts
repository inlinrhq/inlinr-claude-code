import { describe, expect, test } from "bun:test";
import { cloudSession } from "./commands/cloud";

const SID = "7F340819-9c47-5753-86be-5427af8f0e22";

describe("cloudSession", () => {
  test("is the session id in a cloud session", () => {
    expect(
      cloudSession({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_SESSION_ID: SID }),
    ).toBe(SID.toLowerCase());
  });

  test("is null on a laptop, or without a valid id", () => {
    expect(cloudSession({ CLAUDE_CODE_SESSION_ID: SID })).toBeNull();
    expect(
      cloudSession({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_SESSION_ID: "x" }),
    ).toBeNull();
    expect(cloudSession({ CLAUDE_CODE_REMOTE: "true" })).toBeNull();
  });
});
