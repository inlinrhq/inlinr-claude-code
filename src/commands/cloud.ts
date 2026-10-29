/**
 * `activate --cloud`: what a Claude Code cloud session needs to be tracked.
 */

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

export function printCloudSetup(deviceToken: string): void {
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
