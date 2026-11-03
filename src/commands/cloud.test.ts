import { describe, expect, it } from "bun:test";
import { cloudNotice } from "../notice";
import { cloudAccountHeader, cloudSettingsUrl, cloudSteps } from "./cloud";

const TOKEN = /in_d_/;

describe("cloud", () => {
  it("points at Settings → Editors, never at a token", () => {
    const steps = cloudSteps("https://inlinr.com").join("\n");
    expect(steps).toContain(
      "https://inlinr.com/dashboard/settings?section=editors",
    );
    expect(steps).toContain("Setup script");
    expect(steps).not.toMatch(TOKEN);
  });

  it("sends a hash of the claude.ai account, only in the cloud", () => {
    const account = "6d5ab6e2-e430-4d03-8d73-fedde1e2c2ce";
    const header = cloudAccountHeader({
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_ACCOUNT_UUID: account,
    });
    expect(header["x-inlinr-cloud-account"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(header)).not.toContain(account);
    expect(cloudAccountHeader({ CLAUDE_CODE_ACCOUNT_UUID: account })).toEqual(
      {},
    );
    expect(cloudAccountHeader({ CLAUDE_CODE_REMOTE: "true" })).toEqual({});
  });

  it("tells Claude where the line is made, and never to take it in chat", () => {
    const url = cloudSettingsUrl("https://inlinr.com");
    for (const state of ["no-token", "refused"] as const) {
      const text = cloudNotice(state, url);
      expect(text).toContain(url);
      expect(text).toContain("Never ask the user to paste");
      expect(text).not.toMatch(TOKEN);
    }
    expect(cloudNotice("refused", url)).toContain("refused");
  });
});
