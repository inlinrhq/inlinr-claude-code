import {
  closeSync,
  type Dirent,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexFiles, geminiFiles, type SessionFile } from "./agents/sources";
import type { Config } from "./config";

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
export function transcripts(): SessionFile[] {
  const root = claudeProjectsDir();
  const out: SessionFile[] = [];

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
        out.push({
          tool: "claude-code",
          key: full,
          path: full,
          size: st.size,
          mtime: st.mtime,
          subagent,
        });
      } catch {
        // Gone between the listing and the stat.
      }
    }
  };

  walk(root, false);
  return out;
}

/**
 * Every session file this plugin reads: Claude Code's, and those of Codex
 * and Gemini CLI on the same machine. Someone who uses two assistants gets
 * both tracked by the one sync.
 */
export function sessionFiles(): SessionFile[] {
  return [...transcripts(), ...codexFiles(), ...geminiFiles()];
}

/**
 * The part of a file not read yet, up to its last complete line.
 *
 * A transcript is being appended to while we read it. Stopping at the last
 * newline leaves a half-written line for the next sync instead of losing it.
 */
export function readFrom(
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

/** Has this transcript grown since it was last read? */
export function hasNew(config: Config, t: SessionFile): boolean {
  const state = config.files[t.key];
  if (state) return t.size !== state.offset;
  // Never read: only worth opening if it was written after tracking began.
  const since = config.lastParsedAt
    ? Date.parse(config.lastParsedAt)
    : Number.NaN;
  return Number.isNaN(since) || t.mtime.getTime() > since;
}
