import { readFileSync } from "node:fs";
import { type Config, tokenSource } from "../config";
import { logPath } from "../failure";
import { sessionNotice, sharedConnectionNotice } from "../notice";

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
  // Paused on purpose: nothing to say.
  if (config.paused) return 0;
  const source = tokenSource(config);
  // The sync this hook starts next sets `lastParsedAt`: said once.
  const notice =
    source?.from === "machine" && !config.lastParsedAt
      ? sharedConnectionNotice()
      : sessionNotice(Boolean(source), lastLogLine());
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
