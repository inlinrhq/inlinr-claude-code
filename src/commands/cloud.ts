/**
 * `activate --cloud`: what a Claude Code cloud environment needs to be tracked.
 *
 * A cloud session installs no plugin, starts in a fresh container and often
 * outside any repository (a project's threads). What runs in every one is
 * the environment's setup script, so tracking is one line there: inlinr.com's
 * /cloud-setup.sh downloads this bundle from inlinr.com, saves the token and
 * installs these hooks at user level. inlinr.com rather than GitHub: it is
 * the host the beats go to, so an environment that sends them can reach it,
 * while a Custom network policy may block GitHub's raw files.
 */

/** The line pasted into a cloud environment's Setup script. */
export function cloudSetupLine(apiUrl: string, deviceToken: string): string {
  return `curl -fsSL ${apiUrl}/cloud-setup.sh | sh -s -- ${deviceToken}`;
}

export function printCloudSetup(apiUrl: string, deviceToken: string): void {
  console.log("");
  console.log("  Approved. One step in Claude Code on the web, once:");
  console.log("");
  console.log(
    "  Open the cloud environment's settings (claude.ai/code, the gear beside",
  );
  console.log("  the environment) and paste this line into Setup script:");
  console.log("");
  console.log(`     ${cloudSetupLine(apiUrl, deviceToken)}`);
  console.log("");
  console.log(
    "  If its network access is Custom, add inlinr.com to the allowed domains.",
  );
  console.log(
    "  Every session in that environment is then tracked, in every repository,",
  );
  console.log("  and gets new versions of the plugin by itself.");
  console.log("");
  console.log(
    "  The line holds a token: keep it in the environment's settings, never in",
  );
  console.log(
    "  a repository. Remove the device from Settings on inlinr.com to revoke it.",
  );
}
