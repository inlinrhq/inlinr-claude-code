import { describe, expect, it } from "bun:test";
import { isTemporaryRoot } from "./temporary";

describe("isTemporaryRoot", () => {
  it("flags agents' and tests' folders", () => {
    for (const root of [
      "/tmp/kw-2202",
      "/private/var/folders/x1/T/wt-1188m",
      "/var/tmp/agent-3f9a",
      "/tmp/claude-0/-home-user/abc/scratchpad/demo",
      "/home/me/code/app/.claude/worktrees/wt-1188m",
      "C:\\Users\\me\\AppData\\Local\\Temp\\kw-2202",
      "C:\\Temp\\try",
      "/home/me/.cache/pkg/build",
    ]) {
      expect(isTemporaryRoot(root, "/nowhere")).toBe(true);
    }
  });

  it("flags the system's temporary folder, wherever it is", () => {
    expect(isTemporaryRoot("/data/t/x", "/data/t")).toBe(true);
    expect(isTemporaryRoot("D:\\T\\x", "d:\\t\\")).toBe(true);
  });

  it("keeps real projects", () => {
    for (const root of [
      "/home/me/code/rft",
      "D:\\Documents\\GitHub\\inlinr-web",
      "/home/me/code/app/.claude",
      "/home/me/templates/site",
      "/home/me/tmp-notes",
    ]) {
      expect(isTemporaryRoot(root, "/nowhere")).toBe(false);
    }
  });
});
