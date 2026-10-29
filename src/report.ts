import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tell inlinr when a sync breaks, so it shows in Admin → Errors
 * (`POST /api/v1/plugin-errors`).
 *
 * `claude-code.log` keeps every failure on the machine, and `status` points
 * at it, but only someone who already suspects a problem runs `status`. A
 * transcript format the parser no longer understands would stop tracking
 * for every user at once, and we would hear of it last.
 *
 * Only what the server cannot already see: an HTTP answer (a dead token, a
 * refused batch, a 5xx) is on the server's side, and no network is no one's
 * bug. Sent: the step, the message and stack with the home folder replaced
 * by "~" (the server blanks every other path), the plugin version and the
 * operating system. No token, no transcript content. The same error once a
 * day.
 *
 * Off with `error_reports = false` under `[behavior]` in
 * `~/.inlinr/config.toml` (the CLI's switch), `INLINR_ERROR_REPORTS=0`, or
 * when Claude Code's own error reporting or telemetry is turned off.
 */

const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 7 * RESEND_AFTER_MS;
const TIMEOUT_MS = 3000;

/** Whether reports may be sent at all, from the environment and config.toml. */
export function reportsEnabled(
  env: NodeJS.ProcessEnv,
  configToml: string | null,
): boolean {
  const off = (v: string | undefined) =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  if (env.INLINR_ERROR_REPORTS === "0") return false;
  if (
    off(env.DISABLE_ERROR_REPORTING) ||
    off(env.DISABLE_TELEMETRY) ||
    off(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  ) {
    return false;
  }
  return !(configToml && /^\s*error_reports\s*=\s*false\b/m.test(configToml));
}

/**
 * True when the server already knows (it answered with a status) or nobody
 * could (the network was down).
 */
export function isServersOrNetworks(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (typeof (err as { status?: unknown }).status === "number") return true;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err instanceof TypeError && err.message === "fetch failed") return true;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/.test(
      code,
    )
  );
}

/** The home folder becomes "~", in both slash directions. */
export function scrubHome(text: string, home = homedir()): string {
  if (home.length < 3) return text;
  return text.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
}

/** Digits that change between runs (sizes, offsets) do not make a new error. */
export function signature(context: string, message: string): string {
  return `${context}\n${message.replace(/\d{4,}/g, "#")}`;
}

export type ReportOptions = {
  apiUrl: string;
  version: string;
  enabled: boolean;
  /** Remembers what was sent when. */
  statePath: string;
  send?: (url: string, body: string) => Promise<unknown>;
  now?: () => number;
};

function readSent(path: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object"
      ? (raw as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

/** Send `err` from `context` if it is worth it. Resolves, never rejects. */
export async function reportError(
  context: string,
  err: unknown,
  opts: ReportOptions,
): Promise<void> {
  try {
    if (!opts.enabled || isServersOrNetworks(err)) return;
    const error = err instanceof Error ? err : new Error(String(err));
    const message = scrubHome(error.message);
    const key = signature(context, message);
    const t = (opts.now ?? Date.now)();
    const sent = readSent(opts.statePath);
    const last = sent[key];
    if (last !== undefined && t - last < RESEND_AFTER_MS) return;
    sent[key] = t;
    for (const [k, at] of Object.entries(sent)) {
      if (t - at > FORGET_AFTER_MS) delete sent[k];
    }
    try {
      mkdirSync(join(opts.statePath, ".."), { recursive: true });
      writeFileSync(opts.statePath, JSON.stringify(sent), { mode: 0o600 });
    } catch {
      // Without the file a repeat is sent again; the server counts it.
    }

    const body = JSON.stringify({
      source: "claude-code",
      version: `claude-code-inlinr/${opts.version}`,
      platform: `${process.platform}-${process.arch}`,
      editor: "claude-code",
      context,
      message,
      stack: error.stack ? scrubHome(error.stack) : null,
    });
    const send =
      opts.send ??
      ((url: string, b: string) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: b,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }));
    await send(`${opts.apiUrl}/api/v1/plugin-errors`, body);
  } catch {
    // Reporting an error must never cause another one.
  }
}
