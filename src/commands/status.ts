import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { type Config, token, tokenSource } from "../config";
import { logPath } from "../failure";
import { hasNew, sessionFiles } from "../sessions";
import type { AiTool } from "../transcript";
import { VERSION } from "../version";

/**
 * Is this actually working?
 *
 * The question a plugin user has, and the one that took an hour to answer by
 * hand when a stale cache left an old build running against a newer
 * marketplace. Every line here is something that was guessed at during that:
 * which build is running, whether there is a token, when a sync last happened,
 * and how many transcripts are in scope.
 */
export async function status(config: Config): Promise<number> {
  const all = sessionFiles();
  const pending = all.filter((t) => hasNew(config, t)).length;
  const count = (tool: AiTool) => all.filter((t) => t.tool === tool).length;
  const source = tokenSource(config);
  const connected = !source
    ? "not connected — run /inlinr:activate"
    : source.from === "machine"
      ? "connected (this machine's, shared with the inlinr CLI and VS Code)"
      : source.from === "plugin"
        ? "connected (this plugin's own; /inlinr:activate shares it)"
        : "connected (INLINR_TOKEN)";

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
  console.log(
    `              Claude Code ${count("claude-code")}, Codex ${count("codex")}, Gemini CLI ${count("gemini-cli")}`,
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
  const log = logPath();
  if (existsSync(log)) {
    console.log("");
    console.log(`  Errors have been logged to ${log}`);
  }
  console.log("");
  return 0;
}
