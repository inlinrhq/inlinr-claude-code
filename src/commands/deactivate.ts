import { revokeDevice } from "../api";
import {
  type Config,
  machineToken,
  save,
  saveMachineToken,
  tokenSource,
} from "../config";

/**
 * Disconnect this machine. The token is the machine's, shared with the
 * inlinr CLI and the VS Code extension, so they are signed out too: revoking
 * it on inlinr.com would stop them anyway, and saying so beats letting them
 * find out from a failed sync.
 */
export async function deactivate(config: Config): Promise<number> {
  const source = tokenSource(config);
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
  const revoked = await revokeDevice(config.apiUrl, source.token);
  // The local token goes either way. A failed revoke leaves a stale entry in
  // the dashboard, which is annoying; keeping a working token on a machine
  // somebody asked to disconnect is worse.
  if (machineToken() === source.token) saveMachineToken("");
  save({
    ...config,
    deviceToken: "",
    tokenTag: null,
    lastParsedAt: null,
    lastSyncAt: null,
    files: {},
  });
  console.log(
    revoked
      ? "  Disconnected. The device has been revoked on inlinr.com too."
      : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.",
  );
  if (machineToken()) {
    // This plugin's own token (an older release) is gone, but the machine
    // has another one, the CLI's: sessions are tracked with it from now on.
    console.log(
      "  This machine is still connected through the inlinr CLI or VS Code extension, and Claude Code uses that connection. Run /inlinr:deactivate again to disconnect it too.",
    );
  } else if (source.from === "machine") {
    console.log(
      "  The inlinr VS Code extension and CLI on this machine shared this connection: they are signed out too.",
    );
  }
  return 0;
}
