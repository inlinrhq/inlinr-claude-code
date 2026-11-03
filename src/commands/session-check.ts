import { readFileSync } from "node:fs";
import { type Config, tokenSource } from "../config";
import { logPath } from "../failure";
import { cloudNotice, sessionNotice, sharedConnectionNotice } from "../notice";
import { cloudSettingsUrl } from "./cloud";

function lastLogLine(): string | null {
  try {
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

/**
 * A cloud session: the plugin runs there from the claude.ai account or a
 * setup line. Nothing to say when it has a token that works.
 */
function cloudSessionNotice(connected: boolean, apiUrl: string): string | null {
  const url = cloudSettingsUrl(apiUrl);
  if (!connected) return cloudNotice("no-token", url);
  const m = lastLogLine()?.match(/^(\S+) .*HTTP 401/);
  const at = m?.[1] ? Date.parse(m[1]) : Number.NaN;
  return Number.isFinite(at) && Date.now() - at < 48 * 3600 * 1000
    ? cloudNotice("refused", url)
    : null;
}

export function sessionCheck(config: Config): number {
  // Paused on purpose: nothing to say.
  if (config.paused) return 0;
  const source = tokenSource(config);
  const notice =
    process.env.CLAUDE_CODE_REMOTE === "true"
      ? cloudSessionNotice(Boolean(source), config.apiUrl)
      : // The sync this hook starts next sets `lastParsedAt`: said once.
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
