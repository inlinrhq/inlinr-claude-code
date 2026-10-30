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
  // In the cloud this runs from a repository's plugin or hooks, or from the
  // setup line; the way to connect is then the line, not this machine.
  const cloud = process.env.CLAUDE_CODE_REMOTE === "true";
  const notice = sessionNotice(
    Boolean(token(config)),
    lastLogLine(),
    Date.now(),
    cloud ? `node "${process.argv[1]}"` : null,
  );
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
