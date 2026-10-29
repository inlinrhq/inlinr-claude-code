import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, load } from "./config";
import { reportError, reportsEnabled } from "./report";
import { VERSION } from "./version";

/** Where failures are written, for `status` and the session notice to read. */
export const logPath = (): string => join(configDir(), "claude-code.log");

/**
 * Never break the turn — but never disappear either.
 *
 * Swallowing errors is right: a tracker must not fail the thing it measures.
 * Swallowing them *silently* is how a sync that had been failing on every hook
 * looked exactly like a sync that had never run. Failures go to a log with a
 * timestamp; `status` points at it.
 */
export function logFailure(err: unknown): void {
  try {
    const line = `${new Date().toISOString()} ${(err as Error)?.message ?? String(err)}
`;
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(logPath(), line, "utf8");
  } catch {
    // Even the log is best effort.
  }
}

/**
 * A failed sync is also sent to Inlinr (see report.ts): the log tells the
 * user, this tells us. The commands someone types report nothing, they see
 * the error themselves.
 */
export async function reportFailure(err: unknown): Promise<void> {
  let configToml: string | null = null;
  try {
    configToml = readFileSync(join(configDir(), "config.toml"), "utf8");
  } catch {
    // No CLI config: reports stay on.
  }
  await reportError("sync", err, {
    apiUrl: load().apiUrl,
    version: VERSION,
    enabled: reportsEnabled(process.env, configToml),
    statePath: join(configDir(), "error-reports-claude-code.json"),
  });
}
