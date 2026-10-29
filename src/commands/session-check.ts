import { readFileSync } from "node:fs";
import { type Config, token } from "../config";
import { logPath } from "../failure";
import { sessionNotice } from "../notice";

function lastLogLine(): string | null {
  try {
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

export function sessionCheck(config: Config): number {
  // Cloud sessions never have the plugin; their hooks live in the repository.
  if (process.env.CLAUDE_CODE_REMOTE === "true") return 0;
  const notice = sessionNotice(Boolean(token(config)), lastLogLine());
  if (notice) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: notice,
        },
      }),
    );
  }
  return 0;
}
