#!/usr/bin/env node

// src/index.ts
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync as readFileSync2,
  existsSync,
  statSync
} from "node:fs";
import { homedir as homedir2, hostname } from "node:os";
import { join as join2 } from "node:path";

// src/api.ts
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
function toHeartbeats(session, gitRemote, pluginVersion) {
  const plugin = `claude-code-inlinr/${pluginVersion}`;
  const base = {
    editor: "claude-code",
    plugin,
    ai_tool: "claude-code",
    ai_session: session.id,
    ...session.model ? { ai_model: session.model } : {},
    ...gitRemote ? { project_git_remote: gitRemote } : {}
  };
  const beats = coalesceEdits(session.edits).map((edit) => ({
    ...base,
    entity: edit.path,
    type: "file",
    time: Date.parse(edit.timestamp) / 1000,
    category: "coding",
    is_write: true,
    lines_added: edit.linesAdded,
    lines_deleted: edit.linesRemoved,
    ai_lines_added: edit.linesAdded,
    ai_lines_deleted: edit.linesRemoved,
    ai_line_changes: edit.lineChanges
  }));
  const t = session.tokens;
  const anyTokens = t.input > 0 || t.output > 0 || t.cacheRead > 0 || t.cacheWrite > 0;
  if (anyTokens && session.lastSeen) {
    beats.push({
      ...base,
      entity: "claude-code",
      type: "app",
      time: Date.parse(session.lastSeen) / 1000,
      category: "ai",
      ai_input_tokens: t.input,
      ai_output_tokens: t.output,
      ai_cache_read_tokens: t.cacheRead,
      ai_cache_write_tokens: t.cacheWrite
    });
  }
  return beats;
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
      throw Object.assign(new Error(`ingest rejected a batch (HTTP ${res.status})`), { accepted });
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
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null
    };
  } catch {
    return {
      deviceToken: "",
      apiUrl: process.env.INLINR_API_URL?.trim() || DEFAULT_API,
      lastParsedAt: null,
      lastSyncAt: null
    };
  }
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

// src/transcript.ts
var emptyTokens = () => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0
});
var n = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
function parseTranscript(content, since = null) {
  const sinceMs = since ? since.getTime() : null;
  let id = "";
  let cwd = "";
  let model = "";
  const tokens = emptyTokens();
  const edits = [];
  let firstSeen = null;
  let lastSeen = null;
  const seen = new Map;
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
    if (entry.isSidechain === true)
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
    if (firstSeen === null || ts < firstSeen)
      firstSeen = ts;
    if (lastSeen === null || ts > lastSeen)
      lastSeen = ts;
    const message = entry.message;
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
      if (key) {
        const before = seen.get(key);
        if (before) {
          tokens.input += next.input - before.input;
          tokens.cacheRead += next.cacheRead - before.cacheRead;
          tokens.cacheWrite += next.cacheWrite - before.cacheWrite;
          tokens.output += next.output - before.output;
        } else {
          tokens.input += next.input;
          tokens.cacheRead += next.cacheRead;
          tokens.cacheWrite += next.cacheWrite;
          tokens.output += next.output;
        }
        seen.set(key, next);
      } else {
        tokens.input += next.input;
        tokens.cacheRead += next.cacheRead;
        tokens.cacheWrite += next.cacheWrite;
        tokens.output += next.output;
      }
    }
    const result = entry.toolUseResult;
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
        timestamp: new Date(ts).toISOString(),
        lineChanges: added - removed,
        linesAdded: added,
        linesRemoved: removed
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
    firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString()
  };
}
function isEmpty(session) {
  return session.edits.length === 0 && session.tokens.input === 0 && session.tokens.output === 0 && session.tokens.cacheRead === 0 && session.tokens.cacheWrite === 0;
}

// src/index.ts
var VERSION = "0.1.0";
function claudeProjectsDir() {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join2(override || join2(homedir2(), ".claude"), "projects");
}
function transcriptPaths(since) {
  const root = claudeProjectsDir();
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join2(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "subagents")
          continue;
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".jsonl"))
        continue;
      try {
        if (since && statSync(full).mtime <= since)
          continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  };
  walk(root);
  return out;
}
function gitRemote(cwd) {
  if (!cwd)
    return "";
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    }).trim();
  } catch {
    return "";
  }
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {}
}
async function activate(config) {
  const init = await startDeviceFlow(config.apiUrl, hostname(), process.platform);
  openBrowser(init.verification_uri_complete);
  console.log("");
  console.log("  Approve this machine in the browser tab that just opened.");
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
      save({
        ...config,
        deviceToken: result.token,
        lastParsedAt: new Date().toISOString()
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
async function status(config) {
  const paths = transcriptPaths(null);
  const since = config.lastParsedAt ? new Date(config.lastParsedAt) : null;
  const pending = transcriptPaths(since).length;
  console.log("");
  console.log(`  Plugin      ${VERSION}`);
  console.log(`  Machine     ${hostname()}`);
  console.log(`  Account     ${config.deviceToken ? "connected" : "not connected — run /inlinr:activate"}`);
  console.log(`  Server      ${config.apiUrl}`);
  console.log(`  Last sync   ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : "never"}`);
  console.log(`  Transcripts ${paths.length} found, ${pending} with something new`);
  if (config.deviceToken && paths.length === 0) {
    console.log("");
    console.log("  No transcripts found. Claude Code writes them under ~/.claude/projects,");
    console.log("  so this is expected on a machine where you have not used it yet.");
  }
  const log = join2(configDir(), "claude-code.log");
  if (existsSync(log)) {
    console.log("");
    console.log(`  Errors have been logged to ${log}`);
  }
  console.log("");
  return 0;
}
async function deactivate(config) {
  if (!config.deviceToken) {
    console.log("  This machine is not connected.");
    return 0;
  }
  const revoked = await revokeDevice(config.apiUrl, config.deviceToken);
  save({ ...config, deviceToken: "", lastParsedAt: null, lastSyncAt: null });
  console.log(revoked ? "  Disconnected. The device has been revoked on inlinr.com too." : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.");
  return 0;
}
async function sync(config, throttleSeconds) {
  if (!config.deviceToken) {
    return 0;
  }
  if (throttleSeconds > 0 && config.lastSyncAt) {
    const age = Date.now() - Date.parse(config.lastSyncAt);
    if (Number.isFinite(age) && age < throttleSeconds * 1000)
      return 0;
  }
  const since = config.lastParsedAt ? new Date(config.lastParsedAt) : null;
  const paths = transcriptPaths(since);
  if (paths.length === 0) {
    save({ ...config, lastSyncAt: new Date().toISOString() });
    return 0;
  }
  let newest = since;
  const beats = [];
  const remotes = new Map;
  for (const path of paths) {
    let content;
    try {
      content = readFileSync2(path, "utf8");
    } catch {
      continue;
    }
    const session = parseTranscript(content, since);
    if (!session || isEmpty(session))
      continue;
    let remote = remotes.get(session.cwd);
    if (remote === undefined) {
      remote = gitRemote(session.cwd);
      remotes.set(session.cwd, remote);
    }
    if (!remote)
      continue;
    beats.push(...toHeartbeats(session, remote, VERSION));
    if (session.lastSeen) {
      const t = new Date(session.lastSeen);
      if (!newest || t > newest)
        newest = t;
    }
  }
  if (beats.length > 0) {
    await sendHeartbeats(config.apiUrl, config.deviceToken, beats);
  }
  save({
    ...config,
    lastParsedAt: newest ? newest.toISOString() : config.lastParsedAt,
    lastSyncAt: new Date().toISOString()
  });
  return 0;
}
async function main() {
  const args = process.argv.slice(2);
  const config = load();
  if (args[0] === "activate")
    return activate(config);
  if (args[0] === "deactivate")
    return deactivate(config);
  if (args[0] === "status")
    return status(config);
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
    mkdirSync2(configDir(), { recursive: true });
    appendFileSync(join2(configDir(), "claude-code.log"), line, "utf8");
  } catch {}
}
main().then((code) => process.exit(code)).catch((err) => {
  logFailure(err);
  if (process.argv[2] === "activate" || process.argv[2] === "deactivate") {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
});
