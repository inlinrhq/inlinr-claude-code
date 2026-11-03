import { createHash } from "node:crypto";
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
 * `~/.inlinr/` on purpose — the same directory the CLI uses. The token is the
 * machine's: it lives in the CLI's `config.toml` (`[auth] device_token`),
 * where the VS Code extension's CLI and this plugin both read it, so
 * connecting one connects the other. This plugin's own file keeps its read
 * positions, and the token an older release saved there.
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
  /**
   * The token saved here by a release before 0.7.0. Still used first, so a
   * machine connected that way keeps working as it did; activating again
   * moves it to the shared `config.toml` and empties this.
   */
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
  /**
   * Which token the read positions belong to (`tokenTag`). The shared token
   * can change from outside: `inlinr signout` then `inlinr activate`, or a
   * sign-in from VS Code. Tracking then starts over from that moment, as it
   * does on activation, instead of sending what was done while signed out.
   */
  tokenTag?: string | null;
  /**
   * Claude Code (and Codex, Gemini CLI) not tracked on this machine, while
   * the machine's connection stays for the other plugins:
   * `/inlinr:deactivate --pause`. A machine deactivated by a release before
   * 0.7.0 reads as paused too (see `load`): someone who turned this plugin
   * off must not have it start again because VS Code is signed in.
   */
  paused?: boolean;
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

/**
 * `~/.inlinr`. `INLINR_HOME` moves it for the tests only: a repository can
 * set Claude Code's environment, and pointing this folder inside the
 * repository would have the plugin read a token planted there (and send
 * this machine's sessions to its account) or write the token where it gets
 * committed. The bundle is built with `NODE_ENV` set to production, so
 * `dist/index.js` never reads it at all.
 */
export function configDir(): string {
  const override = process.env.INLINR_HOME?.trim();
  if (override && process.env.NODE_ENV === "test") return override;
  return join(homedir(), ".inlinr");
}

const configPath = () => join(configDir(), "claude-code.json");

export function load(): Config {
  try {
    const raw = JSON.parse(
      readFileSync(configPath(), "utf8"),
    ) as Partial<Config>;
    const deviceToken =
      typeof raw.deviceToken === "string" ? raw.deviceToken : "";
    const lastParsedAt =
      typeof raw.lastParsedAt === "string" ? raw.lastParsedAt : null;
    return {
      deviceToken,
      apiUrl: trustedApiUrl(typeof raw.apiUrl === "string" ? raw.apiUrl : null),
      lastParsedAt,
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
      tokenTag: typeof raw.tokenTag === "string" ? raw.tokenTag : null,
      // This file is written only once a token was used. Without a token or
      // a start date, and from before `paused` existed, it was left by
      // `deactivate`: the person turned the plugin off.
      paused:
        typeof raw.paused === "boolean"
          ? raw.paused
          : !deviceToken && !lastParsedAt,
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
      tokenTag: null,
      paused: false,
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
  return tokenSource(config)?.token ?? "";
}

/** Where the token comes from: this file, the machine's, or the environment. */
export type TokenSource = {
  token: string;
  from: "plugin" | "machine" | "env";
};

export function tokenSource(config: Config): TokenSource | null {
  if (config.paused) return null;
  return connection(config);
}

/** The connection this machine has, whether or not this plugin is paused. */
export function connection(config: Config): TokenSource | null {
  if (config.deviceToken) return { token: config.deviceToken, from: "plugin" };
  const machine = machineToken();
  if (machine) return { token: machine, from: "machine" };
  // Only when nothing on the machine says otherwise: in a cloud session, or
  // on a machine nobody connected (a CI runner). A repository can set this
  // variable, so it never overrides a connection made by hand.
  const env = process.env.INLINR_TOKEN?.trim();
  if (env) return { token: env, from: "env" };
  return null;
}

/**
 * A short, one-way tag of a token, to notice it changed without keeping a
 * second copy of it in this file.
 */
export function tokenTag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The shape of every token inlinr.com hands out (`in_d_` + base64url). */
const TOKEN_SHAPE = /^in_d_[A-Za-z0-9_-]{16,128}$/;

const machinePath = () => join(configDir(), "config.toml");

/** The `[auth]` table of config.toml: from its header to the next header. */
function authTable(text: string): { start: number; end: number } | null {
  const header = /^\s*\[auth\]\s*(#.*)?$/m.exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const next = /^\s*\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

const TOKEN_LINE = /^\s*device_token\s*=\s*(["'])([^"'\n]*)\1[^\n]*$/m;

/** The machine's token, from the CLI's config.toml, or "" when there is none. */
export function machineToken(): string {
  let text: string;
  try {
    text = readFileSync(machinePath(), "utf8");
  } catch {
    return "";
  }
  return readMachineToken(text);
}

export function readMachineToken(text: string): string {
  const table = authTable(text);
  if (!table) return "";
  const value = TOKEN_LINE.exec(text.slice(table.start, table.end))?.[2] ?? "";
  // Only a token's shape is taken: this file is also the CLI's settings.
  return TOKEN_SHAPE.test(value) ? value : "";
}

/**
 * config.toml with `device_token` set to `value` ("" to clear it), the rest
 * left as it was. The CLI writes this file with a TOML encoder; editing one
 * line keeps its other settings without a TOML library in the bundle.
 */
export function withMachineToken(text: string, value: string): string {
  if (value && !TOKEN_SHAPE.test(value)) {
    throw new Error("Refusing to save a token that is not an inlinr token.");
  }
  const line = `device_token = "${value}"`;
  const table = authTable(text);
  if (!table) {
    if (!value) return text;
    const sep =
      text === "" || text.endsWith("\n\n")
        ? ""
        : text.endsWith("\n")
          ? "\n"
          : "\n\n";
    return `${text}${sep}[auth]\n  ${line}\n`;
  }
  const body = text.slice(table.start, table.end);
  const found = TOKEN_LINE.exec(body);
  const next = found
    ? body.replace(TOKEN_LINE, (m) => m.replace(/device_token[\s\S]*$/, line))
    : `\n  ${line}${body}`;
  return text.slice(0, table.start) + next + text.slice(table.end);
}

/** Save the machine's token in config.toml, for every plugin to use. */
export function saveMachineToken(value: string): void {
  let text = "";
  try {
    text = readFileSync(machinePath(), "utf8");
  } catch {
    // No CLI on this machine yet: the file starts here.
  }
  const next = withMachineToken(text, value);
  if (next === text) return;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = machinePath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { encoding: "utf8", mode: 0o600 });
  replaceFile(tmp, path);
}

/**
 * Write this file. `deviceToken` is taken from the disk, not from `config`,
 * unless `token` says this call changes it: a sync loaded the file before
 * `inlinr signout` cleared the token, and writing its copy back would bring
 * a revoked token back to life.
 */
export function save(config: Config, token: "keep" | "set" = "keep"): void {
  if (token === "keep") {
    config = {
      ...config,
      deviceToken: diskDeviceToken() ?? config.deviceToken,
    };
  }
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
  replaceFile(tmp, path);
}

/** Codes Windows answers a rename with while another process has the file open. */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Rename `tmp` over `path`. Windows refuses to replace a file another process
 * is reading (the CLI, the extension, another hook), for a few milliseconds:
 * try again a few times before giving up, and never leave `tmp` behind.
 */
export function replaceFile(
  tmp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code) || attempt >= 7) {
        try {
          unlinkSync(tmp);
        } catch {
          // Already gone.
        }
        throw err;
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        10 << Math.min(attempt, 3),
      );
    }
  }
}

function diskDeviceToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as {
      deviceToken?: unknown;
    };
    return typeof raw.deviceToken === "string" ? raw.deviceToken : "";
  } catch {
    return null;
  }
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
