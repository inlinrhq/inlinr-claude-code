#!/usr/bin/env node

// src/index.ts
import { spawn } from "node:child_process";

// src/agents/setup.ts
import {
  copyFileSync,
  existsSync,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { join as join3 } from "node:path";

// src/config.ts
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_API = "https://inlinr.com";
function trustedApiUrl(raw) {
  const value = raw?.trim();
  if (!value)
    return DEFAULT_API;
  try {
    const url = new URL(value);
    const local = (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    const ours = url.protocol === "https:" && (url.hostname === "inlinr.com" || url.hostname === "www.inlinr.com") && !url.port;
    if ((local || ours) && !url.username && !url.password) {
      return url.origin;
    }
  } catch {}
  return DEFAULT_API;
}
function configDir() {
  const override = process.env.INLINR_HOME?.trim();
  if (override && false)
    ;
  return join(homedir(), ".inlinr");
}
var configPath = () => join(configDir(), "claude-code.json");
function load() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    const deviceToken = typeof raw.deviceToken === "string" ? raw.deviceToken : "";
    const lastParsedAt = typeof raw.lastParsedAt === "string" ? raw.lastParsedAt : null;
    return {
      deviceToken,
      apiUrl: trustedApiUrl(typeof raw.apiUrl === "string" ? raw.apiUrl : null),
      lastParsedAt,
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
      tokenTag: typeof raw.tokenTag === "string" ? raw.tokenTag : null,
      paused: typeof raw.paused === "boolean" ? raw.paused : !deviceToken && !lastParsedAt,
      files: raw.files && typeof raw.files === "object" ? raw.files : {}
    };
  } catch {
    return {
      deviceToken: "",
      apiUrl: trustedApiUrl(process.env.INLINR_API_URL),
      lastParsedAt: null,
      lastSyncAt: null,
      tokenTag: null,
      paused: false,
      files: {}
    };
  }
}
function token(config) {
  return tokenSource(config)?.token ?? "";
}
function tokenSource(config) {
  if (config.paused)
    return null;
  return connection(config);
}
function connection(config) {
  if (config.deviceToken)
    return { token: config.deviceToken, from: "plugin" };
  const machine = machineToken();
  if (machine)
    return { token: machine, from: "machine" };
  const env = process.env.INLINR_TOKEN?.trim();
  if (env)
    return { token: env, from: "env" };
  return null;
}
function tokenTag(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
var TOKEN_SHAPE = /^in_d_[A-Za-z0-9_-]{16,128}$/;
var machinePath = () => join(configDir(), "config.toml");
function authTable(text) {
  const header = /^\s*\[auth\]\s*(#.*)?$/m.exec(text);
  if (!header)
    return null;
  const start = header.index + header[0].length;
  const next = /^\s*\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}
var TOKEN_LINE = /^\s*device_token\s*=\s*(["'])([^"'\n]*)\1[^\n]*$/m;
function machineToken() {
  let text;
  try {
    text = readFileSync(machinePath(), "utf8");
  } catch {
    return "";
  }
  return readMachineToken(text);
}
function readMachineToken(text) {
  const table = authTable(text);
  if (!table)
    return "";
  const value = TOKEN_LINE.exec(text.slice(table.start, table.end))?.[2] ?? "";
  return TOKEN_SHAPE.test(value) ? value : "";
}
function withMachineToken(text, value) {
  if (value && !TOKEN_SHAPE.test(value)) {
    throw new Error("Refusing to save a token that is not an inlinr token.");
  }
  const line = `device_token = "${value}"`;
  const table = authTable(text);
  if (!table) {
    if (!value)
      return text;
    const sep = text === "" || text.endsWith(`

`) ? "" : text.endsWith(`
`) ? `
` : `

`;
    return `${text}${sep}[auth]
  ${line}
`;
  }
  const body = text.slice(table.start, table.end);
  const found = TOKEN_LINE.exec(body);
  const next = found ? body.replace(TOKEN_LINE, (m) => m.replace(/device_token[\s\S]*$/, line)) : `
  ${line}${body}`;
  return text.slice(0, table.start) + next + text.slice(table.end);
}
function saveMachineToken(value) {
  let text = "";
  try {
    text = readFileSync(machinePath(), "utf8");
  } catch {}
  const next = withMachineToken(text, value);
  if (next === text)
    return;
  mkdirSync(configDir(), { recursive: true, mode: 448 });
  const path = machinePath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { encoding: "utf8", mode: 384 });
  renameSync(tmp, path);
}
function save(config, token = "keep") {
  if (token === "keep") {
    config = {
      ...config,
      deviceToken: diskDeviceToken() ?? config.deviceToken
    };
  }
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}
`, {
    encoding: "utf8",
    mode: 384
  });
  renameSync(tmp, path);
}
function diskDeviceToken() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return typeof raw.deviceToken === "string" ? raw.deviceToken : "";
  } catch {
    return null;
  }
}
var SYNC_LOCK_STALE_MS = 5 * 60 * 1000;
function acquireSyncLock(now = Date.now()) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-code.lock");
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx", 384));
      return () => {
        try {
          unlinkSync(path);
        } catch {}
      };
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      let age = 0;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age < SYNC_LOCK_STALE_MS)
        return null;
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return null;
}

// src/agents/sources.ts
import { readdirSync, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, join as join2 } from "node:path";
function list(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
}
function stat(path) {
  try {
    const st = statSync2(path);
    return st.isFile() ? { size: st.size, mtime: st.mtime } : null;
  } catch {
    return null;
  }
}
function codexHome() {
  return process.env.CODEX_HOME?.trim() || join2(homedir2(), ".codex");
}
var ROLLOUT = /^rollout-.*\.jsonl$/;
function codexFiles(home = codexHome()) {
  const out = [];
  const add = (path) => {
    const st = stat(path);
    if (st)
      out.push({ tool: "codex", key: `codex:${basename(path)}`, path, ...st });
  };
  const sessions = join2(home, "sessions");
  for (const y of list(sessions)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name))
      continue;
    for (const m of list(join2(sessions, y.name))) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name))
        continue;
      for (const d of list(join2(sessions, y.name, m.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name))
          continue;
        const dir = join2(sessions, y.name, m.name, d.name);
        for (const f of list(dir)) {
          if (f.isFile() && ROLLOUT.test(f.name))
            add(join2(dir, f.name));
        }
      }
    }
  }
  const archived = join2(home, "archived_sessions");
  for (const f of list(archived)) {
    if (f.isFile() && ROLLOUT.test(f.name))
      add(join2(archived, f.name));
  }
  return out;
}
function geminiHome() {
  return join2(homedir2(), ".gemini");
}
function geminiFiles(home = geminiHome()) {
  const out = [];
  const tmp = join2(home, "tmp");
  for (const p of list(tmp)) {
    if (!p.isDirectory())
      continue;
    const chats = join2(tmp, p.name, "chats");
    const files = list(chats).filter((f) => f.isFile() && /^session-.*\.jsonl$/.test(f.name));
    if (files.length === 0)
      continue;
    let root = "";
    try {
      root = readFileSync2(join2(tmp, p.name, ".project_root"), "utf8").trim();
    } catch {}
    for (const f of files) {
      const path = join2(chats, f.name);
      const st = stat(path);
      if (st)
        out.push({
          tool: "gemini-cli",
          key: path,
          path,
          ...st,
          ...root ? { root } : {}
        });
    }
  }
  return out;
}

// src/agents/setup.ts
var standalonePath = () => join3(configDir(), "agents.js");
function bundleVersion(source) {
  return /VERSION = "(\d+\.\d+\.\d+)"/.exec(source)?.[1] ?? null;
}
function older(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0;i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0))
      return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}
function installStandalone(self) {
  const target = standalonePath();
  mkdirSync2(configDir(), { recursive: true });
  if (self !== target)
    copyFileSync(self, target);
  return target;
}
function refreshStandalone(self, version) {
  const target = standalonePath();
  if (self === target || !existsSync(target))
    return;
  const installed = bundleVersion(readFileSync3(target, "utf8"));
  if (installed && !older(installed, version))
    return;
  copyFileSync(self, target);
}
function codexNotify(node, script) {
  const argv = [node, script, "--from", "codex", "--detach"];
  return `notify = [${argv.map((a) => JSON.stringify(a)).join(", ")}]`;
}
function setupCodex(node, script, home = codexHome()) {
  const path = join3(home, "config.toml");
  let toml = "";
  try {
    toml = readFileSync3(path, "utf8");
  } catch {}
  const line = codexNotify(node, script);
  const existing = /^\s*notify\s*=.*$/m.exec(toml);
  if (existing) {
    if (existing[0].includes("--from")) {
      writeFileSync2(path, toml.replace(existing[0], line), "utf8");
      return { ok: true, message: `Updated notify in ${path}.` };
    }
    return {
      ok: false,
      message: `Codex already runs a program after each turn (notify in ${path}), and it takes only one. Run this from that program instead:

     ${JSON.stringify(node)} ${JSON.stringify(script)} --from codex --detach`
    };
  }
  mkdirSync2(home, { recursive: true });
  writeFileSync2(path, `${line}
${toml}`, "utf8");
  return { ok: true, message: `Added notify to ${path}.` };
}
var HOOK_NAME = "inlinr";
function geminiHooks(node, script) {
  return {
    hooks: [
      {
        name: HOOK_NAME,
        type: "command",
        command: `"${node}" "${script}" --from gemini-cli --detach`
      }
    ]
  };
}
function setupGemini(node, script, home = geminiHome()) {
  const path = join3(home, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync3(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      const hooks = {
        AfterAgent: [geminiHooks(node, script)],
        SessionEnd: [geminiHooks(node, script)]
      };
      return {
        ok: false,
        message: `Could not read ${path}. Add this under "hooks" yourself:

${JSON.stringify(hooks, null, 2)}`
      };
    }
  }
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const event of ["AfterAgent", "SessionEnd"]) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const others = groups.filter((g) => !g.hooks?.some((h) => h.name === HOOK_NAME));
    hooks[event] = [...others, geminiHooks(node, script)];
  }
  settings.hooks = hooks;
  mkdirSync2(home, { recursive: true });
  writeFileSync2(path, `${JSON.stringify(settings, null, 2)}
`, "utf8");
  return { ok: true, message: `Added the hooks to ${path}.` };
}

// src/commands/activate.ts
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

// src/api.ts
import { dirname } from "node:path";
async function startDeviceFlow(apiUrl, hostname, platform, editor = "claude-code") {
  const res = await fetch(`${apiUrl}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: hostname,
      editor,
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
function projectOf(repo) {
  return repo.remote ? { project_git_remote: repo.remote } : { project: repo.project };
}
var ACTIVITY_WINDOW_MS = 60 * 1000;
function toHeartbeats(session, resolve, pluginVersion) {
  const plugin = `claude-code-inlinr/${pluginVersion}`;
  const base = {
    editor: session.tool,
    plugin,
    ai_tool: session.tool,
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
    ...projectOf(repo),
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
      entity: session.tool,
      type: "app",
      time: at / 1000,
      category: "ai-coding",
      ...projectOf(repo),
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
async function checkToken(apiUrl, token) {
  try {
    const res = await fetch(`${apiUrl}/api/v1/me/today`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (res.status === 401)
      return "refused";
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// src/commands/cloud.ts
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

// src/commands/activate.ts
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {}
}
async function activate(config, {
  cloud = false,
  replace = false,
  editor = "claude-code"
} = {}) {
  const current = cloud ? null : connection(config);
  if (current && current.from !== "env" && !replace) {
    const state = await checkToken(config.apiUrl, current.token);
    if (state === "unreachable") {
      console.error("  inlinr.com could not be reached to check this machine's connection. Try again when online.");
      return 1;
    }
    if (state === "ok") {
      if (config.paused || !config.lastParsedAt) {
        save({
          ...config,
          paused: false,
          tokenTag: tokenTag(current.token),
          lastParsedAt: new Date().toISOString(),
          lastSyncAt: null,
          files: {}
        });
        console.log("  This machine is already connected. Tracking starts now.");
      } else {
        console.log("  This machine is already connected and tracked.");
      }
      console.log("  To connect it to another inlinr account, run activation with --replace.");
      return 0;
    }
  }
  const init = await startDeviceFlow(config.apiUrl, cloud ? "Claude Code cloud" : hostname(), cloud ? "linux" : process.platform, editor);
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
      const previous = new Set([config.deviceToken, machineToken()].filter(Boolean));
      saveMachineToken(result.token);
      save({
        ...config,
        deviceToken: "",
        tokenTag: tokenTag(result.token),
        paused: false,
        lastParsedAt: new Date().toISOString(),
        files: {}
      }, "set");
      previous.delete(result.token);
      for (const old of previous)
        await revokeDevice(config.apiUrl, old);
      console.log("  Activated. Tracking starts now.");
      console.log("  The inlinr VS Code extension and CLI on this machine use this connection too.");
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

// src/commands/deactivate.ts
async function deactivate(config, mode) {
  const source = connection(config);
  if (!source) {
    console.log("  This machine is not connected.");
    return 0;
  }
  if (source.from === "env") {
    console.log("  This machine uses INLINR_TOKEN. Remove it from the environment to stop tracking.");
    return 0;
  }
  if (!mode) {
    console.log("  Two ways to stop, nothing changed yet:");
    console.log("  --pause    stop tracking Claude Code, Codex and Gemini CLI here; the inlinr extension and CLI keep this machine's connection");
    console.log("  --machine  disconnect this machine: the token is revoked and every inlinr plugin on it stops");
    return 0;
  }
  if (mode === "pause") {
    save({ ...config, paused: true, lastParsedAt: null, files: {} });
    console.log("  Paused. Claude Code, Codex and Gemini CLI are no longer tracked on this machine; /inlinr:activate resumes from that moment.");
    if (source.from === "machine") {
      console.log("  The inlinr extension and CLI keep this machine's connection.");
    }
    return 0;
  }
  const revoked = await revokeDevice(config.apiUrl, source.token);
  if (machineToken() === source.token)
    saveMachineToken("");
  save({
    ...config,
    deviceToken: "",
    tokenTag: null,
    paused: false,
    lastParsedAt: null,
    lastSyncAt: null,
    files: {}
  }, "set");
  console.log(revoked ? "  Disconnected. The device has been revoked on inlinr.com too." : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.");
  if (machineToken()) {
    console.log("  This machine is still connected through the inlinr extension or CLI with another token. Run /inlinr:deactivate --machine again to disconnect it too, or --pause to stop only Claude Code.");
  } else if (source.from === "machine") {
    console.log("  The inlinr extension and CLI on this machine shared this connection: they are signed out too.");
  }
  return 0;
}

// src/commands/session-check.ts
import { readFileSync as readFileSync6 } from "node:fs";

// src/failure.ts
import { appendFileSync, mkdirSync as mkdirSync4, readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";

// src/report.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
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
function scrubHome(text, home = homedir3()) {
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
    const raw = JSON.parse(readFileSync4(path, "utf8"));
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
      mkdirSync3(join4(opts.statePath, ".."), { recursive: true });
      writeFileSync3(opts.statePath, JSON.stringify(sent), { mode: 384 });
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

// src/version.ts
var VERSION = "0.7.0";

// src/failure.ts
var logPath = () => join5(configDir(), "claude-code.log");
function logFailure(err) {
  try {
    const line = `${new Date().toISOString()} ${err?.message ?? String(err)}
`;
    mkdirSync4(configDir(), { recursive: true });
    appendFileSync(logPath(), line, "utf8");
  } catch {}
}
async function reportFailure(err) {
  let configToml = null;
  try {
    configToml = readFileSync5(join5(configDir(), "config.toml"), "utf8");
  } catch {}
  await reportError("sync", err, {
    apiUrl: load().apiUrl,
    version: VERSION,
    enabled: reportsEnabled(process.env, configToml),
    statePath: join5(configDir(), "error-reports-claude-code.json")
  });
}

// src/notice.ts
function sessionNotice(connected, lastLogLine, now = Date.now()) {
  if (!connected) {
    return [
      "inlinr (time tracking plugin) is installed but this machine is not connected to an inlinr account, so nothing is being tracked.",
      "Mention this to the user once, briefly, at a natural point in your first reply, and offer to connect it.",
      "If they agree, use the inlinr:activate skill."
    ].join(" ");
  }
  const m = lastLogLine?.match(/^(\S+) .*HTTP 401/);
  if (m?.[1]) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && now - at < 48 * 3600 * 1000) {
      return [
        "inlinr (time tracking plugin) is installed but inlinr.com refused this machine's token: the device was probably removed from the account, so nothing is being tracked.",
        "Mention this to the user once, briefly, and offer to reconnect it with the inlinr:activate skill."
      ].join(" ");
    }
  }
  return null;
}
function sharedConnectionNotice() {
  return [
    "inlinr (time tracking plugin) now tracks Claude Code sessions on this machine, using the connection the inlinr extension or CLI made here (one connection per machine).",
    "Mention this to the user once, briefly, in your first reply.",
    "If they do not want Claude Code tracked here, run the inlinr:deactivate skill and choose to pause; the extension keeps tracking."
  ].join(" ");
}

// src/commands/session-check.ts
function lastLogLine() {
  try {
    const lines = readFileSync6(logPath(), "utf8").trim().split(`
`);
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}
function sessionCheck(config) {
  if (process.env.CLAUDE_CODE_REMOTE === "true")
    return 0;
  if (config.paused)
    return 0;
  const source = tokenSource(config);
  const notice = source?.from === "machine" && !config.lastParsedAt ? sharedConnectionNotice() : sessionNotice(Boolean(source), lastLogLine());
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

// src/commands/setup.ts
import { resolve } from "node:path";
var self = () => resolve(process.argv[1] ?? "");
function setup(tool) {
  if (tool !== "codex" && tool !== "gemini-cli") {
    console.error("  Usage: setup codex | setup gemini-cli");
    return 2;
  }
  const script = installStandalone(self());
  const result = tool === "codex" ? setupCodex(process.execPath, script) : setupGemini(process.execPath, script);
  console.log("");
  console.log(`  ${result.message}`);
  if (result.ok) {
    console.log(`  ${tool === "codex" ? "Codex" : "Gemini CLI"} now sends its sessions to inlinr after each turn.`);
  }
  console.log("");
  return result.ok ? 0 : 1;
}

// src/commands/status.ts
import { existsSync as existsSync2 } from "node:fs";
import { hostname as hostname2 } from "node:os";

// src/sessions.ts
import {
  closeSync as closeSync2,
  openSync as openSync2,
  readdirSync as readdirSync2,
  readSync,
  statSync as statSync3
} from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";
function claudeProjectsDir() {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join6(override || join6(homedir4(), ".claude"), "projects");
}
function transcripts() {
  const root = claudeProjectsDir();
  const out = [];
  const walk = (dir, subagent) => {
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join6(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "tool-results")
          continue;
        walk(full, subagent || e.name === "subagents");
        continue;
      }
      if (!e.name.endsWith(".jsonl"))
        continue;
      try {
        const st = statSync3(full);
        out.push({
          tool: "claude-code",
          key: full,
          path: full,
          size: st.size,
          mtime: st.mtime,
          subagent
        });
      } catch {}
    }
  };
  walk(root, false);
  return out;
}
function sessionFiles() {
  return [...transcripts(), ...codexFiles(), ...geminiFiles()];
}
function readFrom(path, offset, size) {
  const length = size - offset;
  if (length <= 0)
    return { text: "", end: offset };
  const buf = Buffer.alloc(length);
  const fd = openSync2(path, "r");
  let read = 0;
  try {
    read = readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync2(fd);
  }
  const last = buf.subarray(0, read).lastIndexOf(10);
  if (last < 0)
    return { text: "", end: offset };
  return {
    text: buf.subarray(0, last + 1).toString("utf8"),
    end: offset + last + 1
  };
}
function hasNew(config, t) {
  const state = config.files[t.key];
  if (state)
    return t.size !== state.offset;
  const since = config.lastParsedAt ? Date.parse(config.lastParsedAt) : Number.NaN;
  return Number.isNaN(since) || t.mtime.getTime() > since;
}

// src/commands/status.ts
async function status(config) {
  const all = sessionFiles();
  const pending = all.filter((t) => hasNew(config, t)).length;
  const count = (tool) => all.filter((t) => t.tool === tool).length;
  const source = tokenSource(config);
  const connected = config.paused ? "paused on this machine — /inlinr:activate resumes" : !source ? "not connected — run /inlinr:activate" : source.from === "machine" ? "connected (this machine's, shared with the inlinr CLI and VS Code)" : source.from === "plugin" ? "connected (this plugin's own; /inlinr:activate shares it)" : "connected (INLINR_TOKEN)";
  console.log("");
  console.log(`  Plugin      ${VERSION}`);
  console.log(`  Machine     ${hostname2()}`);
  console.log(`  Account     ${connected}`);
  if (source?.from === "plugin" && machineToken() && machineToken() !== source.token) {
    console.log("              the inlinr extension and CLI here use another connection (two devices, maybe two accounts)");
  }
  console.log(`  Server      ${config.apiUrl}`);
  console.log(`  Last sync   ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : "never"}`);
  console.log(`  Transcripts ${all.length} found, ${pending} with something new`);
  console.log(`              Claude Code ${count("claude-code")}, Codex ${count("codex")}, Gemini CLI ${count("gemini-cli")}`);
  if (token(config) && all.length === 0) {
    console.log("");
    console.log("  No transcripts found. Claude Code writes them under ~/.claude/projects,");
    console.log("  so this is expected on a machine where you have not used it yet.");
  }
  const log = logPath();
  if (existsSync2(log)) {
    console.log("");
    console.log(`  Errors have been logged to ${log}`);
  }
  console.log("");
  return 0;
}

// src/agents/codex.ts
import { isAbsolute, resolve as resolve2 } from "node:path";

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
    if (message && typeof message.model === "string" && message.model && !message.model.startsWith("<")) {
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
    tool: "claude-code",
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

// src/agents/codex.ts
var emptyCodexState = () => ({
  sessionId: "",
  cwd: "",
  model: "",
  startedAt: null,
  lastTotal: null,
  records: false,
  pending: {}
});
var PENDING_TTL_MS = 10 * 60 * 1000;
var n2 = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
var str = (v) => typeof v === "string" ? v : "";
function codexTokens(usage) {
  if (!usage)
    return emptyTokens();
  const cacheRead = n2(usage.cached_input_tokens);
  const cacheWrite = n2(usage.cache_write_input_tokens);
  return {
    input: Math.max(0, n2(usage.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: n2(usage.output_tokens)
  };
}
function parsePatch(patch, cwd) {
  const files = [];
  const where = (p) => isAbsolute(p) || !cwd ? p : resolve2(cwd, p);
  let current = null;
  for (const raw of patch.split(`
`)) {
    const line = raw.replace(/\r$/, "");
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) {
      current = { path: where((file[1] ?? "").trim()), added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.path = where((move[1] ?? "").trim());
      continue;
    }
    if (line.startsWith("***")) {
      current = null;
      continue;
    }
    if (!current)
      continue;
    if (line.startsWith("+"))
      current.added++;
    else if (line.startsWith("-"))
      current.removed++;
  }
  return files;
}
function patchOf(payload) {
  if (payload.name !== "apply_patch")
    return null;
  if (payload.type === "custom_tool_call")
    return str(payload.input) || null;
  if (payload.type === "function_call") {
    try {
      const args = JSON.parse(str(payload.arguments));
      return str(args.input) || str(args.patch) || null;
    } catch {
      return null;
    }
  }
  return null;
}
function applied(output) {
  const text = typeof output === "string" ? output : output && typeof output === "object" ? JSON.stringify(output) : "";
  return /Success\. Updated the following files|Exit code: 0\b|"exit_code":\s*0\b/.test(text);
}
function parseCodex(content, options = {}) {
  const state = {
    ...emptyCodexState(),
    ...options.state,
    pending: { ...options.state?.pending }
  };
  const sinceMs = options.since ? options.since.getTime() : null;
  const tokens = emptyTokens();
  const edits = [];
  const activity = [];
  let firstSeen = null;
  let lastSeen = null;
  const add = (t) => {
    tokens.input += t.input;
    tokens.cacheRead += t.cacheRead;
    tokens.cacheWrite += t.cacheWrite;
    tokens.output += t.output;
  };
  const commit = (callId, at) => {
    const patch = state.pending[callId];
    delete state.pending[callId];
    if (!patch)
      return;
    for (const f of patch.edits) {
      edits.push({
        path: f.path,
        timestamp: at,
        lineChanges: f.added - f.removed,
        linesAdded: f.added,
        linesRemoved: f.removed,
        cwd: patch.cwd
      });
    }
  };
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
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : null;
    if (!payload)
      continue;
    const ts = Date.parse(str(entry.timestamp));
    if (Number.isNaN(ts))
      continue;
    if (entry.type === "session_meta") {
      state.sessionId = str(payload.id) || str(payload.session_id);
      state.cwd = str(payload.cwd) || state.cwd;
      state.startedAt = str(payload.timestamp) || new Date(ts).toISOString();
      continue;
    }
    if (entry.type === "turn_context") {
      state.cwd = str(payload.cwd) || state.cwd;
      state.model = str(payload.model) || state.model;
      continue;
    }
    const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    if (!Number.isNaN(started) && ts < started)
      continue;
    if (sinceMs !== null && ts <= sinceMs)
      continue;
    const at = new Date(ts).toISOString();
    if (entry.type === "token_usage_record") {
      state.records = true;
      add(codexTokens(payload.usage));
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "token_count") {
        if (state.records)
          continue;
        const info = payload.info;
        if (!info)
          continue;
        const total = info.total_token_usage?.total_tokens;
        if (typeof total === "number") {
          if (total === state.lastTotal)
            continue;
          state.lastTotal = total;
        }
        add(codexTokens(info.last_token_usage));
        continue;
      }
      if (payload.type === "patch_apply_end") {
        const id = str(payload.call_id);
        if (payload.success === true)
          commit(id, at);
        else
          delete state.pending[id];
      }
    } else if (entry.type === "response_item") {
      const patch = patchOf(payload);
      const callId = str(payload.call_id);
      if (patch !== null && callId) {
        state.pending[callId] = {
          at,
          cwd: state.cwd,
          edits: parsePatch(patch, state.cwd)
        };
      } else if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && state.pending[callId]) {
        if (applied(payload.output))
          commit(callId, at);
        else
          delete state.pending[callId];
      }
    } else {
      continue;
    }
    if (firstSeen === null || ts < firstSeen)
      firstSeen = ts;
    if (lastSeen === null || ts > lastSeen)
      lastSeen = ts;
    activity.push({ at, cwd: state.cwd });
  }
  const newest = lastSeen ?? Date.now();
  for (const [id, p] of Object.entries(state.pending)) {
    if (newest - Date.parse(p.at) > PENDING_TTL_MS)
      delete state.pending[id];
  }
  if (!state.sessionId)
    return { session: null, state };
  return {
    session: {
      tool: "codex",
      id: state.sessionId,
      cwd: state.cwd,
      model: state.model,
      tokens,
      edits,
      activity,
      firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      carry: null
    },
    state
  };
}
// src/agents/gemini.ts
var KEEP_IDS = 200;
var emptyGeminiState = () => ({
  sessionId: "",
  messages: {},
  toolCalls: []
});
var EDIT_TOOLS = new Set(["write_file", "replace", "edit", "smart_edit"]);
var n3 = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
var str2 = (v) => typeof v === "string" ? v : "";
function geminiTokens(t) {
  if (!t)
    return emptyTokens();
  const cacheRead = n3(t.cached);
  return {
    input: Math.max(0, n3(t.input) - cacheRead),
    cacheRead,
    cacheWrite: 0,
    output: n3(t.output) + n3(t.thoughts)
  };
}
function parseGemini(content, options = {}) {
  const prior = options.state ?? emptyGeminiState();
  const messages = new Map(Object.entries(prior.messages));
  const toolCalls = new Set(prior.toolCalls);
  let sessionId = prior.sessionId;
  let model = "";
  const cwd = options.root ?? "";
  const sinceMs = options.since ? options.since.getTime() : null;
  const tokens = emptyTokens();
  const edits = [];
  const activity = [];
  let firstSeen = null;
  let lastSeen = null;
  const seen = (ts) => {
    if (firstSeen === null || ts < firstSeen)
      firstSeen = ts;
    if (lastSeen === null || ts > lastSeen)
      lastSeen = ts;
    activity.push({ at: new Date(ts).toISOString(), cwd });
  };
  for (const raw of content.split(`
`)) {
    const line = raw.trim();
    if (!line)
      continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object")
      continue;
    if (typeof record.sessionId === "string" && record.id === undefined) {
      sessionId = record.sessionId || sessionId;
      continue;
    }
    if (typeof record.id !== "string" || "$patch" in record)
      continue;
    const type = record.type;
    if (type !== "user" && type !== "gemini")
      continue;
    const ts = Date.parse(str2(record.timestamp));
    if (Number.isNaN(ts))
      continue;
    const fresh = sinceMs === null || ts > sinceMs;
    if (fresh && !messages.has(record.id))
      seen(ts);
    if (type !== "gemini")
      continue;
    if (typeof record.model === "string" && record.model)
      model = record.model;
    const next = geminiTokens(record.tokens);
    const before = messages.get(record.id);
    if (fresh || before) {
      const was = before ?? emptyTokens();
      tokens.input += next.input - was.input;
      tokens.cacheRead += next.cacheRead - was.cacheRead;
      tokens.cacheWrite += next.cacheWrite - was.cacheWrite;
      tokens.output += next.output - was.output;
      messages.delete(record.id);
      messages.set(record.id, next);
    }
    const calls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
    for (const call of calls) {
      const id = str2(call.id);
      if (!id || toolCalls.has(id) || call.status !== "success")
        continue;
      const at = Date.parse(str2(call.timestamp)) || ts;
      if (sinceMs !== null && at <= sinceMs)
        continue;
      toolCalls.add(id);
      seen(at);
      if (!EDIT_TOOLS.has(str2(call.name)))
        continue;
      const args = call.args ?? {};
      const path = str2(args.file_path) || str2(args.absolute_path) || str2(args.path);
      if (!path)
        continue;
      const stat = call.resultDisplay?.diffStat ?? null;
      const added = n3(stat?.model_added_lines);
      const removed = n3(stat?.model_removed_lines);
      edits.push({
        path,
        timestamp: new Date(at).toISOString(),
        lineChanges: added - removed,
        linesAdded: added,
        linesRemoved: removed,
        cwd
      });
    }
  }
  const state = {
    sessionId,
    messages: Object.fromEntries([...messages].slice(-KEEP_IDS)),
    toolCalls: [...toolCalls].slice(-KEEP_IDS)
  };
  if (!sessionId)
    return { session: null, state };
  return {
    session: {
      tool: "gemini-cli",
      id: sessionId,
      cwd,
      model,
      tokens,
      edits,
      activity,
      firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      carry: null
    },
    state
  };
}
// src/repo.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2 } from "node:path";
function git(cwd, args) {
  try {
    return execFileSync2("git", args, {
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
    const project = remote ? undefined : basename2(root);
    if (!remote && !project)
      return null;
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { remote, project, root, branch: branch === "HEAD" ? "" : branch };
  };
  return (dir) => {
    let d = dir;
    while (d && !existsSync3(d)) {
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

// src/commands/sync.ts
async function sync(config, throttleSeconds) {
  const source = tokenSource(config);
  const deviceToken = source?.token ?? "";
  if (!deviceToken) {
    return 0;
  }
  if (source?.from === "plugin" && !machineToken()) {
    try {
      saveMachineToken(deviceToken);
      config = { ...config, deviceToken: "" };
      save(config, "set");
    } catch {}
  }
  const tag = tokenTag(deviceToken);
  const otherToken = config.tokenTag != null && config.tokenTag !== tag;
  if (!config.lastParsedAt || otherToken) {
    save({
      ...config,
      tokenTag: tag,
      lastParsedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      files: otherToken ? {} : config.files
    });
    return 0;
  }
  if (throttleSeconds > 0 && config.lastSyncAt) {
    const age = Date.now() - Date.parse(config.lastSyncAt);
    if (Number.isFinite(age) && age < throttleSeconds * 1000)
      return 0;
  }
  const since = new Date(config.lastParsedAt);
  const all = sessionFiles();
  const files = {};
  const beats = [];
  const resolve = repoResolver();
  for (const t of all) {
    const state = config.files[t.key];
    if (!hasNew(config, t)) {
      if (state)
        files[t.key] = state;
      continue;
    }
    const offset = state && state.offset <= t.size ? state.offset : 0;
    let chunk;
    try {
      chunk = readFrom(t.path, offset, t.size);
    } catch {
      if (state)
        files[t.key] = state;
      continue;
    }
    const floor = state ? null : since;
    const resumed = state && offset > 0 ? state : null;
    let session;
    if (t.tool === "codex") {
      const read = parseCodex(chunk.text, {
        since: floor,
        state: resumed?.agent ?? emptyCodexState()
      });
      session = read.session;
      files[t.key] = { offset: chunk.end, agent: read.state };
    } else if (t.tool === "gemini-cli") {
      const read = parseGemini(chunk.text, {
        since: floor,
        state: resumed?.agent ?? emptyGeminiState(),
        root: t.root
      });
      session = read.session;
      files[t.key] = { offset: chunk.end, agent: read.state };
    } else {
      session = parseTranscript(chunk.text, {
        since: floor,
        carry: resumed?.carry ?? null,
        subagent: t.subagent
      });
      files[t.key] = {
        offset: chunk.end,
        carry: session?.carry ?? state?.carry ?? null
      };
    }
    if (!session || isEmpty(session))
      continue;
    beats.push(...toHeartbeats(session, resolve, VERSION));
  }
  if (beats.length > 0) {
    await sendHeartbeats(config.apiUrl, deviceToken, beats);
  }
  save({
    ...config,
    tokenTag: tag,
    files,
    lastSyncAt: new Date().toISOString()
  });
  return 0;
}

// src/index.ts
async function main() {
  const args = process.argv.slice(2);
  const config = load();
  if (args[0] === "activate") {
    const e = args.indexOf("--editor");
    const editor = e >= 0 ? args[e + 1] : "claude-code";
    if (editor !== "claude-code" && editor !== "codex" && editor !== "gemini-cli") {
      console.error("  --editor takes claude-code, codex or gemini-cli.");
      return 2;
    }
    return activate(config, {
      cloud: args[1] === "--cloud",
      replace: args.includes("--replace"),
      editor
    });
  }
  if (args[0] === "setup")
    return setup(args[1]);
  if (args[0] === "deactivate") {
    const mode = args.includes("--machine") ? "machine" : args.includes("--pause") ? "pause" : null;
    return deactivate(config, mode);
  }
  if (args[0] === "status")
    return status(config);
  if (args[0] === "session-check")
    return sessionCheck(config);
  if (args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (args.includes("--detach")) {
    spawn(process.execPath, [self(), ...args.filter((a) => a !== "--detach")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    if (args.includes("gemini-cli"))
      console.log("{}");
    return 0;
  }
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    try {
      refreshStandalone(self(), VERSION);
    } catch {}
  }
  const i = args.indexOf("--throttle");
  const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
  const release = acquireSyncLock();
  if (!release)
    return 0;
  try {
    return await sync(load(), Number.isFinite(throttle) ? throttle : 0);
  } finally {
    release();
  }
}
var INTERACTIVE = new Set(["activate", "deactivate", "status", "setup"]);
main().then((code) => process.exit(code)).catch(async (err) => {
  logFailure(err);
  if (process.argv[2] === "activate" || process.argv[2] === "deactivate" || process.argv[2] === "setup") {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  if (!INTERACTIVE.has(process.argv[2] ?? ""))
    await reportFailure(err);
  process.exit(0);
});
