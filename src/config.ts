import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
      apiUrl:
        typeof raw.apiUrl === "string" && raw.apiUrl ? raw.apiUrl : DEFAULT_API,
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
      apiUrl: process.env.INLINR_API_URL?.trim() || DEFAULT_API,
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
  const tmp = `${path}.tmp`;
  // Write then rename: a crash mid-write must not leave a truncated file that
  // would reset the watermark and replay the whole history.
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}
