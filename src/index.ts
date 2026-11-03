#!/usr/bin/env node
import { spawn } from "node:child_process";
import { refreshStandalone } from "./agents/setup";
import { activate } from "./commands/activate";
import { deactivate } from "./commands/deactivate";
import { sessionCheck } from "./commands/session-check";
import { self, setup } from "./commands/setup";
import { status } from "./commands/status";
import { sync } from "./commands/sync";
import { acquireSyncLock, load } from "./config";
import { logFailure, reportFailure } from "./failure";
import { VERSION } from "./version";

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
 *
 * This file only dispatches: each command lives in commands/, the sync a
 * hook runs in commands/sync.ts.
 */

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const config = load();

  if (args[0] === "activate") {
    const e = args.indexOf("--editor");
    const editor = e >= 0 ? args[e + 1] : "claude-code";
    if (
      editor !== "claude-code" &&
      editor !== "codex" &&
      editor !== "gemini-cli"
    ) {
      console.error("  --editor takes claude-code, codex or gemini-cli.");
      return 2;
    }
    return activate(config, {
      cloud: args[1] === "--cloud",
      replace: args.includes("--replace"),
      editor,
    });
  }
  if (args[0] === "setup") return setup(args[1]);
  if (args[0] === "deactivate") {
    const mode = args.includes("--machine")
      ? "machine"
      : args.includes("--pause")
        ? "pause"
        : null;
    return deactivate(config, mode);
  }
  if (args[0] === "status") return status(config);
  if (args[0] === "session-check") return sessionCheck(config);
  if (args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }

  // A hook that waits for its command (Gemini CLI's) gets its answer now,
  // and the sync goes on in a process of its own.
  if (args.includes("--detach")) {
    spawn(process.execPath, [self(), ...args.filter((a) => a !== "--detach")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    // Gemini CLI reads a hook's output as JSON.
    if (args.includes("gemini-cli")) console.log("{}");
    return 0;
  }

  // Run by Claude Code: keep a standalone copy set up for another assistant
  // on this build.
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    try {
      refreshStandalone(self(), VERSION);
    } catch {
      // The copy stays as it was; its own sync still runs.
    }
  }

  const i = args.indexOf("--throttle");
  const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
  const release = acquireSyncLock();
  if (!release) return 0;
  try {
    // Read again under the lock: the sync that held it moved the positions.
    return await sync(load(), Number.isFinite(throttle) ? throttle : 0);
  } finally {
    release();
  }
}

// A tracker must never break the turn it is measuring. Every path returns 0
// unless it is the interactive activation command, where an exit code is the
// only way to report failure.
const INTERACTIVE = new Set(["activate", "deactivate", "status", "setup"]);

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    logFailure(err);
    if (
      process.argv[2] === "activate" ||
      process.argv[2] === "deactivate" ||
      process.argv[2] === "setup"
    ) {
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
    if (!INTERACTIVE.has(process.argv[2] ?? "")) await reportFailure(err);
    process.exit(0);
  });
