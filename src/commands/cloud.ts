/**
 * `activate --cloud`: how Claude Code cloud sessions get tracked.
 *
 * A cloud session installs no plugin, starts in a fresh container and often
 * outside any repository (a project's threads). What runs in every container
 * is the environment's setup script, so tracking is one line there, made in
 * inlinr's Settings → Editors: it downloads this bundle from inlinr.com,
 * checks its hash, saves a token of its own and installs the hooks.
 *
 * Nothing here asks for a token. A token printed in a session ends up in its
 * transcript, so the line is only ever shown on inlinr.com, to its owner.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the line is made. */
export function cloudSettingsUrl(apiUrl: string): string {
  return `${apiUrl}/dashboard/settings?section=editors`;
}

export function cloudSteps(apiUrl: string): string[] {
  return [
    "To track Claude Code on the web, once per cloud environment:",
    "",
    `  1. Open ${cloudSettingsUrl(apiUrl)}, choose Add device, then Get the setup line.`,
    "  2. On claude.ai/code, open the settings of a cloud environment only you use",
    "     (the gear beside it) and paste the line into Setup script.",
    "     If its network access is Custom, add inlinr.com to the allowed domains.",
    "",
    "Every session in that environment is then tracked, in every repository.",
    "The line holds a token: it stays on inlinr.com and in the environment's",
    "settings, never in a repository or a chat.",
  ];
}

/**
 * The SHA-256 of the Anthropic account a cloud session runs for, sent as
 * `x-inlinr-cloud-account`: inlinr binds a cloud line to the first account
 * that uses it and refuses the others, so a line in an environment several
 * people use never files their work under its owner. The account id itself
 * never leaves the container. Empty outside the cloud.
 */
export function cloudAccountHeader(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (env.CLAUDE_CODE_REMOTE !== "true") return {};
  const account = env.CLAUDE_CODE_ACCOUNT_UUID?.trim();
  if (!account) return {};
  return {
    "x-inlinr-cloud-account": createHash("sha256")
      .update(account)
      .digest("hex"),
  };
}

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session a cloud container may send for with no token: its id, which
 * the plugin's `mcp_tool` hooks give the inlinr connector (`claim_session`),
 * so inlinr.com knows whose it is. Null outside a cloud session. The server
 * accepts the beats only once the session is claimed: until then a sync is
 * refused and its lines are read again next time.
 */
export function cloudSession(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.CLAUDE_CODE_REMOTE !== "true") return null;
  const id = env.CLAUDE_CODE_SESSION_ID?.trim() ?? "";
  return SESSION_ID.test(id) ? id.toLowerCase() : null;
}

/**
 * Whether `inlinr-cloud`, the companion plugin whose hook claims the session
 * through the connector, is installed here: from a marketplace
 * (`installed_plugins.json`, `cache/`) or synced from the claude.ai account
 * into a cloud container (`synced/<bucket>/<plugin>/`, named by its own
 * manifest, the folder having an id for a name).
 */
export function companionInstalled(claudeDir: string): boolean {
  const plugins = join(claudeDir, "plugins");
  try {
    const installed = JSON.parse(
      readFileSync(join(plugins, "installed_plugins.json"), "utf8"),
    ) as { plugins?: Record<string, unknown> };
    if (
      Object.keys(installed.plugins ?? {}).some((k) =>
        k.startsWith(`${COMPANION}@`),
      )
    )
      return true;
  } catch {}
  for (const bucket of list(join(plugins, "synced"))) {
    for (const plugin of list(join(plugins, "synced", bucket))) {
      try {
        const manifest = JSON.parse(
          readFileSync(
            join(
              plugins,
              "synced",
              bucket,
              plugin,
              ".claude-plugin",
              "plugin.json",
            ),
            "utf8",
          ),
        ) as { name?: unknown };
        if (manifest.name === COMPANION) return true;
      } catch {}
    }
  }
  return false;
}

const COMPANION = "inlinr-cloud";

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}
