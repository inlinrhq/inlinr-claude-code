import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the device token and the sync watermark live.
 *
 * `~/.inlinr/` on purpose — the same directory the CLI uses. Someone running
 * both should not end up activating twice, and a token is a token.
 */

import type { Carry } from "./transcript";

/** How far one transcript has been read. */
export type FileState = {
  /** Bytes already turned into heartbeats. Always at a line boundary. */
  offset: number;
  carry?: Carry | null;
  /** What Codex or Gemini CLI's parser carries from one read to the next. */
  agent?: unknown;
};

export type Config = {
  deviceToken: string;
  apiUrl: string;
  /**
   * ISO. Tracking starts here: a transcript read for the first time skips
   * everything at or before it. Set on activation, and never moved after —
   * each file then keeps its own position in `files`.
   *
   * It used to be the only watermark, advanced to the newest entry across
   * every session at once. Two sessions open side by side then raced: a
   * response that finished writing after the other session's newer line
   * had been read sat behind the watermark and was never sent.
   */
  lastParsedAt: string | null;
  /** ISO. When a sync last ran at all, so a throttle can decline cheaply. */
  lastSyncAt: string | null;
  files: Record<string, FileState>;
};

export const DEFAULT_API = "https://inlinr.com";

/**
 * The server to talk to: inlinr.com, or this machine for development. The
 * token and every beat go there, and a repository can set environment
 * variables for Claude Code (`env` in its .claude/settings.json), so any
 * other address, `http://` included, falls back to inlinr.com rather than
 * hand them to whoever wrote that file.
 */
export function trustedApiUrl(raw: string | undefined | null): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_API;
  try {
    const url = new URL(value);
    const local =
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    const ours =
      url.protocol === "https:" &&
      (url.hostname === "inlinr.com" || url.hostname === "www.inlinr.com") &&
      !url.port;
    if ((local || ours) && !url.username && !url.password) {
      return url.origin;
    }
  } catch {
    // Not a URL: the default.
  }
  return DEFAULT_API;
}

export function configDir(): string {
  const override = process.env.INLINR_HOME?.trim();
  if (override) return override;
  return join(homedir(), ".inlinr");
}

const configPath = () => join(configDir(), "claude-code.json");

export function load(): Config {
  try {
    const raw = JSON.parse(
      readFileSync(configPath(), "utf8"),
    ) as Partial<Config>;
    return {
      deviceToken: typeof raw.deviceToken === "string" ? raw.deviceToken : "",
      apiUrl: trustedApiUrl(typeof raw.apiUrl === "string" ? raw.apiUrl : null),
      lastParsedAt:
        typeof raw.lastParsedAt === "string" ? raw.lastParsedAt : null,
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
      files: raw.files && typeof raw.files === "object" ? raw.files : {},
    };
  } catch {
    // Missing or unreadable means "not activated yet", which is a normal
    // state rather than an error worth surfacing on every hook.
    return {
      deviceToken: "",
      apiUrl: trustedApiUrl(process.env.INLINR_API_URL),
      lastParsedAt: null,
      lastSyncAt: null,
      files: {},
    };
  }
}

/**
 * The token to send with, from the config file or the environment.
 *
 * `INLINR_TOKEN` is for machines nobody activates by hand: a Claude Code
 * cloud session starts in a fresh container every time, so a token saved by
 * `/inlinr:activate` is gone by the next one. Set once in the environment's
 * settings, it applies to every session.
 */
export function token(config: Config): string {
  return config.deviceToken || process.env.INLINR_TOKEN?.trim() || "";
}

export function save(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  // Its own temporary file: two processes sharing one name rename it from
  // under each other (ENOENT on rename).
  const tmp = `${path}.${process.pid}.tmp`;
  // Write then rename: a crash mid-write must not leave a truncated file that
  // would reset the watermark and replay the whole history.
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** A sync older than this is taken for dead: its lock no longer counts. */
export const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Hold the sync to one process at a time.
 *
 * Hooks run asynchronously and can overlap: two syncs then read the same
 * transcript lines and both send them, counting the time, lines and tokens
 * twice. Returns a release function, or null when another sync holds the
 * lock (that one sends the same lines; the next hook picks up the rest).
 */
export function acquireSyncLock(now = Date.now()): (() => void) | null {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-code.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // Already gone: nothing to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        continue; // Released between the two calls: try again.
      }
      if (age < SYNC_LOCK_STALE_MS) return null;
      // Left by a sync that crashed or was killed.
      try {
        unlinkSync(path);
      } catch {
        // Another process took it over first.
      }
    }
  }
  return null;
}
