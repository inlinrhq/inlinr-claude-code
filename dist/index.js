#!/usr/bin/env node

// src/index.ts
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync as mkdirSync3,
  openSync,
  readdirSync,
  readFileSync as readFileSync3,
  readSync,
  statSync
} from "node:fs";
import { homedir as homedir3, hostname } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";

// src/api.ts
import { dirname } from "node:path";
async function startDeviceFlow(apiUrl, hostname, platform) {
  const res = await fetch(`${apiUrl}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: hostname,
      editor: "claude-code",
      platform
    })
  });
  if (!res.ok)
    throw new Error(`could not start activation (HTTP ${res.status})`);
  return await res.json();
}
async function pollDeviceToken(apiUrl, deviceCode) {
  const res = await fetch(`${apiUrl}/api/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode })
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && typeof body.access_token === "string") {
    return { status: "ok", token: body.access_token };
  }
  if (body.error === "authorization_pending")
    return { status: "pending" };
  return {
    status: "denied",
    error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`
  };
}
var COALESCE_WINDOW_MS = 2 * 60 * 1000;
function coalesceEdits(edits) {
  const byBucket = new Map;
  for (const edit of edits) {
    const at = Date.parse(edit.timestamp);
    if (Number.isNaN(at))
      continue;
    const bucket = Math.floor(at / COALESCE_WINDOW_MS);
    const key = `${edit.path}|${bucket}`;
    const found = byBucket.get(key);
    if (!found) {
      byBucket.set(key, { ...edit });
      continue;
    }
    found.linesAdded += edit.linesAdded;
    found.linesRemoved += edit.linesRemoved;
    found.lineChanges += edit.lineChanges;
    if (at > Date.parse(found.timestamp))
      found.timestamp = edit.timestamp;
  }
  return [...byBucket.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
var ACTIVITY_WINDOW_MS = 60 * 1000;
function toHeartbeats(session, resolve, pluginVersion) {
  const plugin = `claude-code-inlinr/${pluginVersion}`;
  const base = {
    editor: "claude-code",
    plugin,
    ai_tool: "claude-code",
    ai_session: session.id,
    ...session.model ? { ai_model: session.model } : {}
  };
  const edits = coalesceEdits(session.edits).flatMap((edit) => {
    const repo = resolve(dirname(edit.path)) ?? (edit.cwd ? resolve(edit.cwd) : null);
    return repo ? [{ edit, repo }] : [];
  });
  const beats = edits.map(({ edit, repo }) => ({
    ...base,
    entity: edit.path,
    type: "file",
    time: Date.parse(edit.timestamp) / 1000,
    category: "coding",
    project_git_remote: repo.remote,
    ...repo.branch ? { branch: repo.branch } : {},
    is_write: true,
    lines_added: edit.linesAdded,
    lines_deleted: edit.linesRemoved,
    ai_lines_added: edit.linesAdded,
    ai_lines_deleted: edit.linesRemoved,
    ai_line_changes: edit.lineChanges
  }));
  const nearestEdit = (at) => {
    let best = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const { edit, repo } of edits) {
      const gap = Math.abs(Date.parse(edit.timestamp) - at);
      if (gap < bestGap) {
        bestGap = gap;
        best = repo;
      }
    }
    return best;
  };
  const windows = new Map;
  for (const a of session.activity) {
    const at = Date.parse(a.at);
    if (Number.isNaN(at))
      continue;
    const repo = (a.cwd ? resolve(a.cwd) : null) ?? nearestEdit(at);
    if (!repo)
      continue;
    const key = `${repo.root}|${Math.floor(at / ACTIVITY_WINDOW_MS)}`;
    const found = windows.get(key);
    if (found && found.time * 1000 >= at)
      continue;
    windows.set(key, {
      ...base,
      entity: "claude-code",
      type: "app",
      time: at / 1000,
      category: "ai-coding",
      project_git_remote: repo.remote,
      ...repo.branch ? { branch: repo.branch } : {}
    });
  }
  const activity = [...windows.values()].sort((a, b) => a.time - b.time);
  beats.push(...activity);
  const t = session.tokens;
  const anyTokens = t.input > 0 || t.output > 0 || t.cacheRead > 0 || t.cacheWrite > 0;
  const last = activity.at(-1);
  if (anyTokens && last) {
    last.ai_input_tokens = t.input;
    last.ai_output_tokens = t.output;
    last.ai_cache_read_tokens = t.cacheRead;
    last.ai_cache_write_tokens = t.cacheWrite;
  }
  return beats.sort((a, b) => a.time - b.time);
}
var MAX_BATCH = 1000;
async function sendHeartbeats(apiUrl, token, beats) {
  let accepted = 0;
  for (let i = 0;i < beats.length; i += MAX_BATCH) {
    const chunk = beats.slice(i, i + MAX_BATCH);
    const res = await fetch(`${apiUrl}/api/v1/heartbeats`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      throw Object.assign(new Error(`ingest rejected a batch (HTTP ${res.status})`), { accepted, status: res.status });
    }
    const body = await res.json().catch(() => ({}));
    accepted += typeof body.accepted === "number" ? body.accepted : chunk.length;
  }
  return { accepted };
}
async function revokeDevice(apiUrl, token) {
  try {
    const res = await fetch(`${apiUrl}/api/auth/device/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    return res.ok;
  } catch {
    return false;
  }
}

// src/config.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_API = "https://inlinr.com";
function configDir() {
  const override = process.env.INLINR_HOME?.trim();
  if (override)
    return override;
  return join(homedir(), ".inlinr");
}
var configPath = () => join(configDir(), "claude-code.json");
function load() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return {
      deviceToken: typeof raw.deviceToken === "string" ? raw.deviceToken : "",
      apiUrl: typeof raw.apiUrl === "string" && raw.apiUrl ? raw.apiUrl : DEFAULT_API,
      lastParsedAt: typeof raw.lastParsedAt === "string" ? raw.lastParsedAt : null,
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
      files: raw.files && typeof raw.files === "object" ? raw.files : {}
    };
  } catch {
    return {
      deviceToken: "",
      apiUrl: process.env.INLINR_API_URL?.trim() || DEFAULT_API,
      lastParsedAt: null,
      lastSyncAt: null,
      files: {}
    };
  }
}
function token(config) {
  return config.deviceToken || process.env.INLINR_TOKEN?.trim() || "";
}
function save(config) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}
`, {
    encoding: "utf8",
    mode: 384
  });
  renameSync(tmp, path);
}

// src/notice.ts
function sessionNotice(connected, lastLogLine, now = Date.now()) {
  if (!connected) {
    return [
      "Inlinr (time tracking plugin) is installed but this machine is not connected to an Inlinr account, so nothing is being tracked.",
      "Mention this to the user once, briefly, at a natural point in your first reply, and offer to connect it.",
      "If they agree, use the inlinr:activate skill."
    ].join(" ");
  }
  const m = lastLogLine?.match(/^(\S+) .*HTTP 401/);
  if (m?.[1]) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && now - at < 48 * 3600 * 1000) {
      return [
        "Inlinr (time tracking plugin) is installed but inlinr.com refused this machine's token: the device was probably removed from the account, so nothing is being tracked.",
        "Mention this to the user once, briefly, and offer to reconnect it with the inlinr:activate skill."
      ].join(" ");
    }
  }
  return null;
}

// src/report.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
var FORGET_AFTER_MS = 7 * RESEND_AFTER_MS;
var TIMEOUT_MS = 3000;
function reportsEnabled(env, configToml) {
  const off = (v) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  if (env.INLINR_ERROR_REPORTS === "0")
    return false;
  if (off(env.DISABLE_ERROR_REPORTING) || off(env.DISABLE_TELEMETRY) || off(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return false;
  }
  return !(configToml && /^\s*error_reports\s*=\s*false\b/m.test(configToml));
}
function isServersOrNetworks(err) {
  if (!(err instanceof Error))
    return false;
  if (typeof err.status === "number")
    return true;
  if (err.name === "AbortError" || err.name === "TimeoutError")
    return true;
  if (err instanceof TypeError && err.message === "fetch failed")
    return true;
  const code = err.code;
  return typeof code === "string" && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/.test(code);
}
function scrubHome(text, home = homedir2()) {
  if (home.length < 3)
    return text;
  return text.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
}
function signature(context, message) {
  return `${context}
${message.replace(/\d{4,}/g, "#")}`;
}
function readSent(path) {
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
async function reportError(context, err, opts) {
  try {
    if (!opts.enabled || isServersOrNetworks(err))
      return;
    const error = err instanceof Error ? err : new Error(String(err));
    const message = scrubHome(error.message);
    const key = signature(context, message);
    const t = (opts.now ?? Date.now)();
    const sent = readSent(opts.statePath);
    const last = sent[key];
    if (last !== undefined && t - last < RESEND_AFTER_MS)
      return;
    sent[key] = t;
    for (const [k, at] of Object.entries(sent)) {
      if (t - at > FORGET_AFTER_MS)
        delete sent[k];
    }
    try {
      mkdirSync2(join2(opts.statePath, ".."), { recursive: true });
      writeFileSync2(opts.statePath, JSON.stringify(sent), { mode: 384 });
    } catch {}
    const body = JSON.stringify({
      source: "claude-code",
      version: `claude-code-inlinr/${opts.version}`,
      platform: `${process.platform}-${process.arch}`,
      editor: "claude-code",
      context,
      message,
      stack: error.stack ? scrubHome(error.stack) : null
    });
    const send = opts.send ?? ((url, b) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: b,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }));
    await send(`${opts.apiUrl}/api/v1/plugin-errors`, body);
  } catch {}
}

// src/transcript.ts
var emptyTokens = () => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0
});
var n = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
function parseTranscript(content, options = {}) {
  const sinceMs = options.since ? options.since.getTime() : null;
  let id = "";
  let cwd = "";
  let model = "";
  const tokens = emptyTokens();
  const edits = [];
  const activity = [];
  let firstSeen = null;
  let lastSeen = null;
  let carry = options.carry ?? null;
  const seen = new Map;
  if (carry)
    seen.set(carry.id, carry);
  for (const raw of content.split(`
`)) {
    const line = raw.trim();
    if (!line)
      continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain === true && !options.subagent)
      continue;
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isNaN(ts))
      continue;
    if (typeof entry.sessionId === "string" && entry.sessionId)
      id = entry.sessionId;
    if (typeof entry.cwd === "string" && entry.cwd)
      cwd = entry.cwd;
    if (sinceMs !== null && ts <= sinceMs)
      continue;
    const message = entry.message;
    const result = entry.toolUseResult;
    if (!message && !result)
      continue;
    if (firstSeen === null || ts < firstSeen)
      firstSeen = ts;
    if (lastSeen === null || ts > lastSeen)
      lastSeen = ts;
    const at = new Date(ts).toISOString();
    activity.push({ at, cwd });
    if (message && typeof message.model === "string" && message.model) {
      model = message.model;
    }
    const usage = message?.usage ?? entry.usage ?? null;
    if (usage) {
      const next = {
        input: n(usage.input_tokens),
        cacheRead: n(usage.cache_read_input_tokens),
        cacheWrite: n(usage.cache_creation_input_tokens),
        output: n(usage.output_tokens)
      };
      const key = typeof message?.id === "string" && message.id ? message.id : "";
      const before = key && seen.get(key) || emptyTokens();
      tokens.input += next.input - before.input;
      tokens.cacheRead += next.cacheRead - before.cacheRead;
      tokens.cacheWrite += next.cacheWrite - before.cacheWrite;
      tokens.output += next.output - before.output;
      if (key)
        seen.set(key, next);
      carry = key ? { id: key, ...next } : null;
    }
    if (result && typeof result.filePath === "string" && result.filePath) {
      const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
      let added = 0;
      let removed = 0;
      for (const hunk of patch) {
        added += n(hunk.newLines);
        removed += n(hunk.oldLines);
      }
      edits.push({
        path: result.filePath,
        timestamp: at,
        lineChanges: added - removed,
        linesAdded: added,
        linesRemoved: removed,
        cwd
      });
    }
  }
  if (!id)
    return null;
  return {
    id,
    cwd,
    model,
    tokens,
    edits,
    activity,
    firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    carry
  };
}
function isEmpty(session) {
  return session.edits.length === 0 && session.activity.length === 0 && session.tokens.input === 0 && session.tokens.output === 0 && session.tokens.cacheRead === 0 && session.tokens.cacheWrite === 0;
}

// src/index.ts
var VERSION = "0.4.0";
function claudeProjectsDir() {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join3(override || join3(homedir3(), ".claude"), "projects");
}
function transcripts() {
  const root = claudeProjectsDir();
  const out = [];
  const walk = (dir, subagent) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join3(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "tool-results")
          continue;
        walk(full, subagent || e.name === "subagents");
        continue;
      }
      if (!e.name.endsWith(".jsonl"))
        continue;
      try {
        const st = statSync(full);
        out.push({ path: full, size: st.size, mtime: st.mtime, subagent });
      } catch {}
    }
  };
  walk(root, false);
  return out;
}
function readFrom(path, offset, size) {
  const length = size - offset;
  if (length <= 0)
    return { text: "", end: offset };
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    read = readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const last = buf.subarray(0, read).lastIndexOf(10);
  if (last < 0)
    return { text: "", end: offset };
  return {
    text: buf.subarray(0, last + 1).toString("utf8"),
    end: offset + last + 1
  };
}
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    }).trim();
  } catch {
    return "";
  }
}
function firstRemote(root) {
  const name = git(root, ["remote"]).split(`
`)[0]?.trim();
  return name ? git(root, ["remote", "get-url", name]) : "";
}
function repoResolver() {
  const cache = new Map;
  const lookup = (dir) => {
    const root = git(dir, ["rev-parse", "--show-toplevel"]);
    if (!root)
      return null;
    const remote = git(root, ["remote", "get-url", "origin"]) || firstRemote(root);
    if (!remote)
      return null;
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { remote, root, branch: branch === "HEAD" ? "" : branch };
  };
  return (dir) => {
    let d = dir;
    while (d && !existsSync(d)) {
      const up = dirname2(d);
      if (up === d)
        return null;
      d = up;
    }
    if (!d)
      return null;
    const hit = cache.get(d);
    if (hit !== undefined)
      return hit;
    const repo = lookup(d);
    cache.set(d, repo);
    return repo;
  };
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {}
}
async function activate(config, cloud = false) {
  const init = await startDeviceFlow(config.apiUrl, cloud ? "Claude Code cloud" : hostname(), cloud ? "linux" : process.platform);
  openBrowser(init.verification_uri_complete);
  console.log("");
  console.log(cloud ? "  Approve Claude Code cloud in the browser tab that just opened." : "  Approve this machine in the browser tab that just opened.");
  console.log(`  If it did not open: ${init.verification_uri_complete}`);
  console.log("");
  console.log(`  The code, if it asks: ${init.user_code}`);
  const deadline = Date.now() + init.expires_in * 1000;
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
      save({
        ...config,
        deviceToken: result.token,
        lastParsedAt: new Date().toISOString(),
        files: {}
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
var CLOUD_SCRIPT = "https://raw.githubusercontent.com/inlinrhq/inlinr-claude-code/main/dist/index.js";
function cloudHook(throttle) {
  const run = `f=/tmp/inlinr-claude-code.js; [ -s "$f" ] || curl -fsSL ${CLOUD_SCRIPT} -o "$f"; node "$f"`;
  return `[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0; ${run}${throttle ? ` --throttle ${throttle}` : ""}`;
}
function printCloudSetup(deviceToken) {
  const hook = (throttle) => [
    {
      hooks: [
        {
          type: "command",
          command: cloudHook(throttle),
          timeout: 20,
          async: true
        }
      ]
    }
  ];
  const settings = {
    hooks: {
      SessionStart: hook(0),
      UserPromptSubmit: hook(120),
      PostToolUse: hook(120),
      SubagentStop: hook(120),
      Stop: hook(0),
      SessionEnd: hook(0)
    }
  };
  console.log("");
  console.log("  Approved. Three steps in Claude Code on the web:");
  console.log("");
  console.log("  1. In the cloud environment's settings, add this environment variable:");
  console.log("");
  console.log(`     INLINR_TOKEN=${deviceToken}`);
  console.log("");
  console.log("  2. In the same settings, set network access to Custom, add inlinr.com,");
  console.log("     and keep the default list of package managers.");
  console.log("");
  console.log("  3. Merge this into .claude/settings.json in each repository you work on:");
  console.log("");
  console.log(JSON.stringify(settings, null, 2).split(`
`).map((l) => `     ${l}`).join(`
`));
  console.log("");
  console.log("  Keep the token private: anyone using the environment can read it.");
  console.log("  Remove the device from Settings on inlinr.com to revoke it.");
}
async function status(config) {
  const all = transcripts();
  const pending = all.filter((t) => hasNew(config, t)).length;
  const connected = token(config) ? config.deviceToken ? "connected" : "connected (INLINR_TOKEN)" : "not connected — run /inlinr:activate";
  console.log("");
  console.log(`  Plugin      ${VERSION}`);
  console.log(`  Machine     ${hostname()}`);
  console.log(`  Account     ${connected}`);
  console.log(`  Server      ${config.apiUrl}`);
  console.log(`  Last sync   ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : "never"}`);
  console.log(`  Transcripts ${all.length} found, ${pending} with something new`);
  if (token(config) && all.length === 0) {
    console.log("");
    console.log("  No transcripts found. Claude Code writes them under ~/.claude/projects,");
    console.log("  so this is expected on a machine where you have not used it yet.");
  }
  const log = join3(configDir(), "claude-code.log");
  if (existsSync(log)) {
    console.log("");
    console.log(`  Errors have been logged to ${log}`);
  }
  console.log("");
  return 0;
}
function lastLogLine() {
  try {
    const lines = readFileSync3(join3(configDir(), "claude-code.log"), "utf8").trim().split(`
`);
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}
function sessionCheck(config) {
  if (process.env.CLAUDE_CODE_REMOTE === "true")
    return 0;
  const notice = sessionNotice(Boolean(token(config)), lastLogLine());
  if (notice) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: notice
      }
    }));
  }
  return 0;
}
async function deactivate(config) {
  if (!config.deviceToken) {
    console.log(token(config) ? "  This machine uses INLINR_TOKEN. Remove it from the environment to stop tracking." : "  This machine is not connected.");
    return 0;
  }
  const revoked = await revokeDevice(config.apiUrl, config.deviceToken);
  save({
    ...config,
    deviceToken: "",
    lastParsedAt: null,
    lastSyncAt: null,
    files: {}
  });
  console.log(revoked ? "  Disconnected. The device has been revoked on inlinr.com too." : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.");
  return 0;
}
function hasNew(config, t) {
  const state = config.files[t.path];
  if (state)
    return t.size !== state.offset;
  const since = config.lastParsedAt ? Date.parse(config.lastParsedAt) : Number.NaN;
  return Number.isNaN(since) || t.mtime.getTime() > since;
}
async function sync(config, throttleSeconds) {
  const deviceToken = token(config);
  if (!deviceToken) {
    return 0;
  }
  if (!config.lastParsedAt) {
    save({
      ...config,
      lastParsedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString()
    });
    return 0;
  }
  if (throttleSeconds > 0 && config.lastSyncAt) {
    const age = Date.now() - Date.parse(config.lastSyncAt);
    if (Number.isFinite(age) && age < throttleSeconds * 1000)
      return 0;
  }
  const since = new Date(config.lastParsedAt);
  const all = transcripts();
  const files = {};
  const beats = [];
  const resolve = repoResolver();
  for (const t of all) {
    const state = config.files[t.path];
    if (!hasNew(config, t)) {
      if (state)
        files[t.path] = state;
      continue;
    }
    const offset = state && state.offset <= t.size ? state.offset : 0;
    let chunk;
    try {
      chunk = readFrom(t.path, offset, t.size);
    } catch {
      if (state)
        files[t.path] = state;
      continue;
    }
    const session = parseTranscript(chunk.text, {
      since: state ? null : since,
      carry: state && offset > 0 ? state.carry : null,
      subagent: t.subagent
    });
    files[t.path] = {
      offset: chunk.end,
      carry: session?.carry ?? state?.carry ?? null
    };
    if (!session || isEmpty(session))
      continue;
    beats.push(...toHeartbeats(session, resolve, VERSION));
  }
  if (beats.length > 0) {
    await sendHeartbeats(config.apiUrl, deviceToken, beats);
  }
  save({
    ...config,
    files,
    lastSyncAt: new Date().toISOString()
  });
  return 0;
}
async function main() {
  const args = process.argv.slice(2);
  const config = load();
  if (args[0] === "activate")
    return activate(config, args[1] === "--cloud");
  if (args[0] === "deactivate")
    return deactivate(config);
  if (args[0] === "status")
    return status(config);
  if (args[0] === "session-check")
    return sessionCheck(config);
  if (args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }
  const i = args.indexOf("--throttle");
  const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
  return sync(config, Number.isFinite(throttle) ? throttle : 0);
}
function logFailure(err) {
  try {
    const line = `${new Date().toISOString()} ${err?.message ?? String(err)}
`;
    mkdirSync3(configDir(), { recursive: true });
    appendFileSync(join3(configDir(), "claude-code.log"), line, "utf8");
  } catch {}
}
async function reportFailure(err) {
  let configToml = null;
  try {
    configToml = readFileSync3(join3(configDir(), "config.toml"), "utf8");
  } catch {}
  await reportError("sync", err, {
    apiUrl: load().apiUrl,
    version: VERSION,
    enabled: reportsEnabled(process.env, configToml),
    statePath: join3(configDir(), "error-reports-claude-code.json")
  });
}
var INTERACTIVE = new Set(["activate", "deactivate", "status"]);
main().then((code) => process.exit(code)).catch(async (err) => {
  logFailure(err);
  if (process.argv[2] === "activate" || process.argv[2] === "deactivate") {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  if (!INTERACTIVE.has(process.argv[2] ?? ""))
    await reportFailure(err);
  process.exit(0);
});
export {
  cloudHook
};
