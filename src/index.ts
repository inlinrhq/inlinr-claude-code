#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  pollDeviceToken,
  type Repo,
  type ResolveRepo,
  revokeDevice,
  sendHeartbeats,
  startDeviceFlow,
  toHeartbeats,
} from "./api";
import { type Config, configDir, load, save, token } from "./config";
import { sessionNotice } from "./notice";
import { reportError, reportsEnabled } from "./report";
import { isEmpty, parseTranscript } from "./transcript";

/**
 * The whole plugin, with no binary to install.
 *
 * Claude Code is a Node program, so Node is on the machine by definition.
 * Asking someone to download an unsigned executable — and then to argue with
 * their antivirus about it — in order to hand an API key to a plugin was the
 * wrong trade. Everything the plugin needs is a JSONL parser, two HTTP calls
 * and a token file.
 *
 * The CLI still exists and is still the right thing for editors that are not
 * Node programs. It is no longer a prerequisite for this one.
 */

const VERSION = "0.4.0";

function claudeProjectsDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(override || join(homedir(), ".claude"), "projects");
}

/**
 * Every transcript, with its size and modification time.
 *
 * One stat per file rather than a read: a file whose size has not moved since
 * the last sync is skipped without opening it — this runs on every hook.
 *
 * `subagents` directories are included. A subagent's lines are written there
 * and nowhere else, so skipping them dropped everything a subagent did: its
 * time, its tokens, its edits.
 */
type Transcript = {
  path: string;
  size: number;
  mtime: Date;
  subagent: boolean;
};

function transcripts(): Transcript[] {
  const root = claudeProjectsDir();
  const out: Transcript[] = [];

  const walk = (dir: string, subagent: boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Tool output Claude Code saved to disk, not a transcript.
        if (e.name === "tool-results") continue;
        walk(full, subagent || e.name === "subagents");
        continue;
      }
      if (!e.name.endsWith(".jsonl")) continue;
      try {
        const st = statSync(full);
        out.push({ path: full, size: st.size, mtime: st.mtime, subagent });
      } catch {
        // Gone between the listing and the stat.
      }
    }
  };

  walk(root, false);
  return out;
}

/**
 * The part of a file not read yet, up to its last complete line.
 *
 * A transcript is being appended to while we read it. Stopping at the last
 * newline leaves a half-written line for the next sync instead of losing it.
 */
function readFrom(
  path: string,
  offset: number,
  size: number,
): { text: string; end: number } {
  const length = size - offset;
  if (length <= 0) return { text: "", end: offset };
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    read = readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const last = buf.subarray(0, read).lastIndexOf(0x0a);
  if (last < 0) return { text: "", end: offset };
  return {
    text: buf.subarray(0, last + 1).toString("utf8"),
    end: offset + last + 1,
  };
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

function firstRemote(root: string): string {
  const name = git(root, ["remote"]).split("\n")[0]?.trim();
  return name ? git(root, ["remote", "get-url", name]) : "";
}

/**
 * The repository a directory belongs to, cached for the length of one sync.
 *
 * A deleted file's directory may be gone too, so the nearest existing parent
 * stands in for it — it is in the same repository.
 */
function repoResolver(): ResolveRepo {
  const cache = new Map<string, Repo | null>();
  const lookup = (dir: string): Repo | null => {
    const root = git(dir, ["rev-parse", "--show-toplevel"]);
    if (!root) return null;
    // `origin` first, else the first remote — the same rule as the CLI and
    // the VS Code extension, so a fork whose only remote is `upstream` is
    // tracked here too instead of silently skipped.
    const remote =
      git(root, ["remote", "get-url", "origin"]) || firstRemote(root);
    if (!remote) return null;
    // Checked out now, not when the line was written — the transcript's
    // own `gitBranch` is the starting folder's, wrong for any other repo.
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { remote, root, branch: branch === "HEAD" ? "" : branch };
  };
  return (dir: string) => {
    let d = dir;
    while (d && !existsSync(d)) {
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
    if (!d) return null;
    const hit = cache.get(d);
    if (hit !== undefined) return hit;
    const repo = lookup(d);
    cache.set(d, repo);
    return repo;
  };
}

/**
 * Open a URL in the user's browser.
 *
 * Best effort: if it fails the link is already printed, so nothing is lost —
 * and a headless machine or an SSH session is a normal place to run this.
 */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? // `start` is a cmd builtin, not a program, and its first quoted
        // argument is taken as the window title — hence the empty one.
        ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {
    // Printed above; the user can click it.
  }
}

/**
 * `cloud` gets a token for Claude Code cloud sessions instead of this
 * machine. Those start in a fresh container every time, so a token saved to
 * disk is gone by the next session — it has to live in the environment's
 * settings, and the user has to see it to paste it there.
 */
async function activate(config: Config, cloud = false): Promise<number> {
  const init = await startDeviceFlow(
    config.apiUrl,
    cloud ? "Claude Code cloud" : hostname(),
    cloud ? "linux" : process.platform,
  );

  // Opened before anything is printed. The link already carries the code, so
  // in the normal case nobody has to read the code at all — and reading it
  // out of a scrolling tool-call log is exactly what made this feel slow.
  openBrowser(init.verification_uri_complete);

  console.log("");
  console.log(
    cloud
      ? "  Approve Claude Code cloud in the browser tab that just opened."
      : "  Approve this machine in the browser tab that just opened.",
  );
  console.log(`  If it did not open: ${init.verification_uri_complete}`);
  console.log("");
  console.log(`  The code, if it asks: ${init.user_code}`);

  const deadline = Date.now() + init.expires_in * 1000;
  // The server's `interval` is a floor, not a schedule. Waiting a full five
  // seconds before even the first check makes an approval that already
  // happened feel like a hang; a short first poll costs one request.
  const wait = Math.max(1, init.interval) * 1000;
  let delay = 800;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = wait;
    const result = await pollDeviceToken(config.apiUrl, init.device_code);
    if (result.status === "ok") {
      if (cloud) {
        printCloudSetup(result.token);
        return 0;
      }
      // The clock starts now.
      //
      // Claude Code keeps every transcript it has ever written — a month of
      // them on the machine this was found on, 8000 edits. Uploading all of
      // that the moment somebody connects a plugin is not something they
      // asked for: it is months of past work, attributed to projects they
      // may not have wanted tracked, in one enormous request. A tracker
      // starts tracking when you turn it on.
      save({
        ...config,
        deviceToken: result.token,
        lastParsedAt: new Date().toISOString(),
        files: {},
      });
      console.log("  Activated. Tracking starts now.");
      return 0;
    }
    if (result.status === "denied") {
      console.error(`  Activation failed: ${result.error}`);
      return 1;
    }
  }
  console.error("  That code expired. Run activation again.");
  return 1;
}

/**
 * The URL of this build, for a cloud session to fetch.
 *
 * GitHub is reachable from a cloud session by default; inlinr.com has to be
 * added to the environment's network allowlist either way, for the beats.
 */
const CLOUD_SCRIPT =
  "https://raw.githubusercontent.com/inlinrhq/inlinr-claude-code/main/dist/index.js";

/**
 * A hook for a repository's own `.claude/settings.json`.
 *
 * A cloud session does not install plugins, not even the ones a repository
 * enables, but it does run the hooks a repository declares. So the cloud
 * runs the same script through a hook committed to the repository.
 *
 * It does nothing on a laptop (`CLAUDE_CODE_REMOTE` is only set in the
 * cloud), where the plugin already runs: two copies reading the same
 * transcripts against one state file would send everything twice.
 */
export function cloudHook(throttle: number): string {
  const run = `f=/tmp/inlinr-claude-code.js; [ -s "$f" ] || curl -fsSL ${CLOUD_SCRIPT} -o "$f"; node "$f"`;
  return `[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0; ${run}${throttle ? ` --throttle ${throttle}` : ""}`;
}

function printCloudSetup(deviceToken: string): void {
  const hook = (throttle: number) => [
    {
      hooks: [
        {
          type: "command",
          command: cloudHook(throttle),
          timeout: 20,
          async: true,
        },
      ],
    },
  ];
  const settings = {
    hooks: {
      SessionStart: hook(0),
      UserPromptSubmit: hook(120),
      PostToolUse: hook(120),
      SubagentStop: hook(120),
      Stop: hook(0),
      SessionEnd: hook(0),
    },
  };
  console.log("");
  console.log("  Approved. Three steps in Claude Code on the web:");
  console.log("");
  console.log(
    "  1. In the cloud environment's settings, add this environment variable:",
  );
  console.log("");
  console.log(`     INLINR_TOKEN=${deviceToken}`);
  console.log("");
  console.log(
    "  2. In the same settings, set network access to Custom, add inlinr.com,",
  );
  console.log("     and keep the default list of package managers.");
  console.log("");
  console.log(
    "  3. Merge this into .claude/settings.json in each repository you work on:",
  );
  console.log("");
  console.log(
    JSON.stringify(settings, null, 2)
      .split("\n")
      .map((l) => `     ${l}`)
      .join("\n"),
  );
  console.log("");
  console.log(
    "  Keep the token private: anyone using the environment can read it.",
  );
  console.log("  Remove the device from Settings on inlinr.com to revoke it.");
}

/**
 * Is this actually working?
 *
 * The question a plugin user has, and the one that took an hour to answer by
 * hand when a stale cache left an old build running against a newer
 * marketplace. Every line here is something that was guessed at during that:
 * which build is running, whether there is a token, when a sync last happened,
 * and how many transcripts are in scope.
 */
async function status(config: Config): Promise<number> {
  const all = transcripts();
  const pending = all.filter((t) => hasNew(config, t)).length;
  const connected = token(config)
    ? config.deviceToken
      ? "connected"
      : "connected (INLINR_TOKEN)"
    : "not connected — run /inlinr:activate";

  console.log("");
  console.log(`  Plugin      ${VERSION}`);
  console.log(`  Machine     ${hostname()}`);
  console.log(`  Account     ${connected}`);
  console.log(`  Server      ${config.apiUrl}`);
  console.log(
    `  Last sync   ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : "never"}`,
  );
  console.log(
    `  Transcripts ${all.length} found, ${pending} with something new`,
  );

  if (token(config) && all.length === 0) {
    console.log("");
    console.log(
      "  No transcripts found. Claude Code writes them under ~/.claude/projects,",
    );
    console.log(
      "  so this is expected on a machine where you have not used it yet.",
    );
  }
  const log = join(configDir(), "claude-code.log");
  if (existsSync(log)) {
    console.log("");
    console.log(`  Errors have been logged to ${log}`);
  }
  console.log("");
  return 0;
}

function lastLogLine(): string | null {
  try {
    const lines = readFileSync(join(configDir(), "claude-code.log"), "utf8")
      .trim()
      .split("\n");
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

function sessionCheck(config: Config): number {
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

async function deactivate(config: Config): Promise<number> {
  if (!config.deviceToken) {
    console.log(
      token(config)
        ? "  This machine uses INLINR_TOKEN. Remove it from the environment to stop tracking."
        : "  This machine is not connected.",
    );
    return 0;
  }
  const revoked = await revokeDevice(config.apiUrl, config.deviceToken);
  // The local token goes either way. A failed revoke leaves a stale entry in
  // the dashboard, which is annoying; keeping a working token on a machine
  // somebody asked to disconnect is worse.
  save({
    ...config,
    deviceToken: "",
    lastParsedAt: null,
    lastSyncAt: null,
    files: {},
  });
  console.log(
    revoked
      ? "  Disconnected. The device has been revoked on inlinr.com too."
      : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.",
  );
  return 0;
}

/** Has this transcript grown since it was last read? */
function hasNew(config: Config, t: Transcript): boolean {
  const state = config.files[t.path];
  if (state) return t.size !== state.offset;
  // Never read: only worth opening if it was written after tracking began.
  const since = config.lastParsedAt
    ? Date.parse(config.lastParsedAt)
    : Number.NaN;
  return Number.isNaN(since) || t.mtime.getTime() > since;
}

async function sync(config: Config, throttleSeconds: number): Promise<number> {
  const deviceToken = token(config);
  if (!deviceToken) {
    // Silent on purpose. A hook firing on every tool call must not print an
    // error into somebody's session because they have not activated yet.
    return 0;
  }

  if (!config.lastParsedAt) {
    // A token from the environment, never activated here: tracking starts
    // now, for the same reason it does on activation. In a cloud session
    // the SessionStart hook gets here before any work has happened.
    save({
      ...config,
      lastParsedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
    });
    return 0;
  }

  if (throttleSeconds > 0 && config.lastSyncAt) {
    const age = Date.now() - Date.parse(config.lastSyncAt);
    if (Number.isFinite(age) && age < throttleSeconds * 1000) return 0;
  }

  const since = new Date(config.lastParsedAt);
  const all = transcripts();
  const files: Config["files"] = {};
  const beats = [];
  const resolve = repoResolver();

  for (const t of all) {
    const state = config.files[t.path];
    if (!hasNew(config, t)) {
      // Kept only while the file exists, so the map does not grow with
      // every session ever deleted.
      if (state) files[t.path] = state;
      continue;
    }

    // A file that shrank was rewritten; start it over.
    const offset = state && state.offset <= t.size ? state.offset : 0;
    let chunk: { text: string; end: number };
    try {
      chunk = readFrom(t.path, offset, t.size);
    } catch {
      if (state) files[t.path] = state;
      continue;
    }

    const session = parseTranscript(chunk.text, {
      // Only a file read for the first time needs the floor; a known one
      // resumes exactly where it stopped.
      since: state ? null : since,
      carry: state && offset > 0 ? state.carry : null,
      subagent: t.subagent,
    });
    files[t.path] = {
      offset: chunk.end,
      carry: session?.carry ?? state?.carry ?? null,
    };
    if (!session || isEmpty(session)) continue;

    beats.push(...toHeartbeats(session, resolve, VERSION));
  }

  // Positions are saved only once the beats have landed. A failed send
  // throws past this point, and the next sync reads the same lines again.
  if (beats.length > 0) {
    await sendHeartbeats(config.apiUrl, deviceToken, beats);
  }

  save({
    ...config,
    files,
    lastSyncAt: new Date().toISOString(),
  });
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const config = load();

  if (args[0] === "activate") return activate(config, args[1] === "--cloud");
  if (args[0] === "deactivate") return deactivate(config);
  if (args[0] === "status") return status(config);
  if (args[0] === "session-check") return sessionCheck(config);
  if (args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }

  const i = args.indexOf("--throttle");
  const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
  return sync(config, Number.isFinite(throttle) ? throttle : 0);
}

// A tracker must never break the turn it is measuring. Every path returns 0
// unless it is the interactive activation command, where an exit code is the
// only way to report failure.
/**
 * Never break the turn — but never disappear either.
 *
 * Swallowing errors is right: a tracker must not fail the thing it measures.
 * Swallowing them *silently* is how a sync that had been failing on every hook
 * looked exactly like a sync that had never run. Failures go to a log with a
 * timestamp; `status` points at it.
 */
function logFailure(err: unknown): void {
  try {
    const line = `${new Date().toISOString()} ${(err as Error)?.message ?? String(err)}
`;
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(join(configDir(), "claude-code.log"), line, "utf8");
  } catch {
    // Even the log is best effort.
  }
}

/**
 * A failed sync is also sent to Inlinr (see report.ts): the log tells the
 * user, this tells us. The commands someone types report nothing, they see
 * the error themselves.
 */
async function reportFailure(err: unknown): Promise<void> {
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

const INTERACTIVE = new Set(["activate", "deactivate", "status"]);

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    logFailure(err);
    if (process.argv[2] === "activate" || process.argv[2] === "deactivate") {
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
    if (!INTERACTIVE.has(process.argv[2] ?? "")) await reportFailure(err);
    process.exit(0);
  });
