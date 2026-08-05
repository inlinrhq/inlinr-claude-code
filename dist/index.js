#!/usr/bin/env node

// src/index.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/api.ts
async function startDeviceFlow(apiUrl, platform) {
  const res = await fetch(`${apiUrl}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "claude-code-inlinr",
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
  const beats = session.edits.map((edit) => ({
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
async function sendHeartbeats(apiUrl, token, beats) {
  if (beats.length === 0)
    return { accepted: 0 };
  const res = await fetch(`${apiUrl}/api/v1/heartbeats`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(beats)
  });
  if (!res.ok)
    throw new Error(`ingest rejected the batch (HTTP ${res.status})`);
  const body = await res.json().catch(() => ({}));
  return { accepted: typeof body.accepted === "number" ? body.accepted : 0 };
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
  const init = await startDeviceFlow(config.apiUrl, process.platform);
  console.log("");
  console.log(`  Code: ${init.user_code}`);
  console.log(`  ${init.verification_uri_complete}`);
  console.log("");
  console.log("  Opening that page in your browser. Approve it there.");
  openBrowser(init.verification_uri_complete);
  const deadline = Date.now() + init.expires_in * 1000;
  const wait = Math.max(1, init.interval) * 1000;
  let delay = 800;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = wait;
    const result = await pollDeviceToken(config.apiUrl, init.device_code);
    if (result.status === "ok") {
      save({ ...config, deviceToken: result.token });
      console.log("  Activated. Nothing else to set up.");
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
  if (args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }
  const i = args.indexOf("--throttle");
  const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
  return sync(config, Number.isFinite(throttle) ? throttle : 0);
}
main().then((code) => process.exit(code)).catch((err) => {
  if (process.argv[2] === "activate") {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
});
