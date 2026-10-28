import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AiTool } from "../transcript";

/**
 * The session files of the other assistants on this machine.
 *
 * Each has a `key` for its read position in `claude-code.json`. For Claude
 * Code and Gemini CLI it is the path. For Codex it is the file's name: Codex
 * moves a session from `sessions/YYYY/MM/DD/` to `archived_sessions/` when
 * it is archived, and keyed on the path the moved file would be read again
 * from the start, every line sent twice.
 */
export type SessionFile = {
  tool: AiTool;
  key: string;
  path: string;
  size: number;
  mtime: Date;
  /** A Claude Code subagent's own file. */
  subagent?: boolean;
  /** Gemini CLI: the folder the session ran in. */
  root?: string;
};

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
}

function stat(path: string): { size: number; mtime: Date } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtime: st.mtime } : null;
  } catch {
    return null;
  }
}

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

const ROLLOUT = /^rollout-.*\.jsonl$/;

/** `sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/rollout-*`. */
export function codexFiles(home = codexHome()): SessionFile[] {
  const out: SessionFile[] = [];
  const add = (path: string) => {
    const st = stat(path);
    if (st)
      out.push({ tool: "codex", key: `codex:${basename(path)}`, path, ...st });
  };
  const sessions = join(home, "sessions");
  for (const y of list(sessions)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const m of list(join(sessions, y.name))) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      for (const d of list(join(sessions, y.name, m.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const dir = join(sessions, y.name, m.name, d.name);
        for (const f of list(dir)) {
          if (f.isFile() && ROLLOUT.test(f.name)) add(join(dir, f.name));
        }
      }
    }
  }
  const archived = join(home, "archived_sessions");
  for (const f of list(archived)) {
    if (f.isFile() && ROLLOUT.test(f.name)) add(join(archived, f.name));
  }
  return out;
}

export function geminiHome(): string {
  return join(homedir(), ".gemini");
}

/** `tmp/<project>/chats/session-*.jsonl`, with the project's folder. */
export function geminiFiles(home = geminiHome()): SessionFile[] {
  const out: SessionFile[] = [];
  const tmp = join(home, "tmp");
  for (const p of list(tmp)) {
    if (!p.isDirectory()) continue;
    const chats = join(tmp, p.name, "chats");
    const files = list(chats).filter(
      (f) => f.isFile() && /^session-.*\.jsonl$/.test(f.name),
    );
    if (files.length === 0) continue;
    let root = "";
    try {
      root = readFileSync(join(tmp, p.name, ".project_root"), "utf8").trim();
    } catch {
      // An older folder named by a hash of the path: edits still carry
      // absolute paths, and activity goes with the nearest edit.
    }
    for (const f of files) {
      const path = join(chats, f.name);
      const st = stat(path);
      if (st)
        out.push({
          tool: "gemini-cli",
          key: path,
          path,
          ...st,
          ...(root ? { root } : {}),
        });
    }
  }
  return out;
}
