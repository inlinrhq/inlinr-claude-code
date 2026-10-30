import { revokeDevice } from "../api";
import {
  type Config,
  connection,
  machineToken,
  save,
  saveMachineToken,
} from "../config";

export type DeactivateMode = "pause" | "machine" | null;

/**
 * Stop tracking. Two different wishes, so two commands:
 *
 * - `--pause`: stop tracking Claude Code (and Codex, Gemini CLI) here. The
 *   machine stays connected for the inlinr extension and the CLI; nothing
 *   is revoked. `/inlinr:activate` resumes, from that moment.
 * - `--machine`: disconnect the machine. The token is the machine's, shared
 *   with the extension and the CLI, so it is revoked and every plugin on the
 *   machine stops.
 *
 * Without either, it says what each does and changes nothing: the skill asks
 * the person which they mean.
 */
export async function deactivate(
  config: Config,
  mode: DeactivateMode,
): Promise<number> {
  const source = connection(config);
  if (!source) {
    console.log("  This machine is not connected.");
    return 0;
  }
  if (source.from === "env") {
    console.log(
      "  This machine uses INLINR_TOKEN. Remove it from the environment to stop tracking.",
    );
    return 0;
  }
  if (!mode) {
    console.log("  Two ways to stop, nothing changed yet:");
    console.log(
      "  --pause    stop tracking Claude Code, Codex and Gemini CLI here; the inlinr extension and CLI keep this machine's connection",
    );
    console.log(
      "  --machine  disconnect this machine: the token is revoked and every inlinr plugin on it stops",
    );
    return 0;
  }

  if (mode === "pause") {
    save({ ...config, paused: true, lastParsedAt: null, files: {} });
    console.log(
      "  Paused. Claude Code, Codex and Gemini CLI are no longer tracked on this machine; /inlinr:activate resumes from that moment.",
    );
    if (source.from === "machine") {
      console.log(
        "  The inlinr extension and CLI keep this machine's connection.",
      );
    }
    return 0;
  }

  const revoked = await revokeDevice(config.apiUrl, source.token);
  // The local token goes either way. A failed revoke leaves a stale entry in
  // the dashboard, which is annoying; keeping a working token on a machine
  // somebody asked to disconnect is worse.
  if (machineToken() === source.token) saveMachineToken("");
  save(
    {
      ...config,
      deviceToken: "",
      tokenTag: null,
      paused: false,
      lastParsedAt: null,
      lastSyncAt: null,
      files: {},
    },
    "set",
  );
  console.log(
    revoked
      ? "  Disconnected. The device has been revoked on inlinr.com too."
      : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.",
  );
  if (machineToken()) {
    // This plugin's own token (an older release) is gone, but the machine
    // has another one, the CLI's: sessions would be tracked with it.
    console.log(
      "  This machine is still connected through the inlinr extension or CLI with another token. Run /inlinr:deactivate --machine again to disconnect it too, or --pause to stop only Claude Code.",
    );
  } else if (source.from === "machine") {
    console.log(
      "  The inlinr extension and CLI on this machine shared this connection: they are signed out too.",
    );
  }
  return 0;
}
