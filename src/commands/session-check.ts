import { readFileSync } from "node:fs";
import { type Config, tokenSource } from "../config";
import { logPath } from "../failure";
import { cloudNotice, sessionNotice, sharedConnectionNotice } from "../notice";
import { claudeDir, cloudSettingsUrl, companionInstalled } from "./cloud";

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
async function cloudSessionNotice(
  connected: boolean,
  apiUrl: string,
): Promise<string | null> {
  const url = cloudSettingsUrl(apiUrl);
  const tracked = connected || companionInstalled(claudeDir());
  if (!tracked) return cloudNotice("no-token", url);
  // Set to send: by a token, or as a session the connector claims. Either
  // way the beats leave from this container, and an environment's default
  // network access does not let it reach inlinr.com. The claim still works
  // (claude.ai calls the connector), so nothing else would ever say so.
  if (!(await reachable(apiUrl))) return cloudNotice("blocked", url);
  if (!connected) return null;
  const m = lastLogLine()?.match(/^(\S+) .*HTTP 401/);
  const at = m?.[1] ? Date.parse(m[1]) : Number.NaN;
  return Number.isFinite(at) && Date.now() - at < 48 * 3600 * 1000
    ? cloudNotice("refused", url)
    : null;
}

/**
 * Whether inlinr.com answers from here at all: any HTTP status will do.
 * A domain the environment does not allow fails to resolve at once, so the
 * wait is only for a slow network, and stays inside the hook's 5 s.
 */
export async function reachable(
  apiUrl: string,
  timeoutMs = 2500,
): Promise<boolean> {
  try {
    await fetch(apiUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export async function sessionCheck(config: Config): Promise<number> {
  // Paused on purpose: nothing to say.
  if (config.paused) return 0;
  const source = tokenSource(config);
  const notice =
    process.env.CLAUDE_CODE_REMOTE === "true"
      ? await cloudSessionNotice(Boolean(source), config.apiUrl)
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
