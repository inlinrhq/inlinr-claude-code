import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { pollDeviceToken, startDeviceFlow } from "../api";
import { type Config, save, saveMachineToken, tokenTag } from "../config";
import type { AiTool } from "../transcript";
import { printCloudSetup } from "./cloud";

/**
 * Open a URL in the user's browser.
 *
 * Best effort: if it fails the link is already printed, so nothing is lost —
 * and a headless machine or an SSH session is a normal place to run this.
 */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? // `start` is a cmd builtin, not a program, and its first quoted
        // argument is taken as the window title — hence the empty one.
        ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  } catch {
    // Printed above; the user can click it.
  }
}

/**
 * `cloud` gets a token for Claude Code cloud sessions instead of this
 * machine. Those start in a fresh container every time, so a token saved to
 * disk is gone by the next session — it has to live in the environment's
 * settings, and the user has to see it to paste it there.
 */
export async function activate(
  config: Config,
  cloud = false,
  editor: AiTool = "claude-code",
): Promise<number> {
  const init = await startDeviceFlow(
    config.apiUrl,
    cloud ? "Claude Code cloud" : hostname(),
    cloud ? "linux" : process.platform,
    editor,
  );

  // Opened before anything is printed. The link already carries the code, so
  // in the normal case nobody has to read the code at all — and reading it
  // out of a scrolling tool-call log is exactly what made this feel slow.
  openBrowser(init.verification_uri_complete);

  console.log("");
  console.log(
    cloud
      ? "  Approve Claude Code cloud in the browser tab that just opened."
      : "  Approve this machine in the browser tab that just opened.",
  );
  console.log(`  If it did not open: ${init.verification_uri_complete}`);
  console.log("");
  console.log(`  The code, if it asks: ${init.user_code}`);

  const deadline = Date.now() + init.expires_in * 1000;
  // The server's `interval` is a floor, not a schedule. Waiting a full five
  // seconds before even the first check makes an approval that already
  // happened feel like a hang; a short first poll costs one request.
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
      // The clock starts now.
      //
      // Claude Code keeps every transcript it has ever written — a month of
      // them on the machine this was found on, 8000 edits. Uploading all of
      // that the moment somebody connects a plugin is not something they
      // asked for: it is months of past work, attributed to projects they
      // may not have wanted tracked, in one enormous request. A tracker
      // starts tracking when you turn it on.
      //
      // The token goes to config.toml, the machine's connection: the inlinr
      // CLI and the VS Code extension on this machine send with it too.
      saveMachineToken(result.token);
      save({
        ...config,
        deviceToken: "",
        tokenTag: tokenTag(result.token),
        lastParsedAt: new Date().toISOString(),
        files: {},
      });
      console.log("  Activated. Tracking starts now.");
      console.log(
        "  The inlinr VS Code extension and CLI on this machine use this connection too.",
      );
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
