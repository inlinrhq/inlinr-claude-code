import { revokeDevice } from "../api";
import { type Config, save, token } from "../config";

export async function deactivate(config: Config): Promise<number> {
  if (!config.deviceToken) {
    console.log(
      token(config)
        ? "  This machine uses INLINR_TOKEN. Remove it from the environment to stop tracking."
        : "  This machine is not connected.",
    );
    return 0;
  }
  const revoked = await revokeDevice(config.apiUrl, config.deviceToken);
  // The local token goes either way. A failed revoke leaves a stale entry in
  // the dashboard, which is annoying; keeping a working token on a machine
  // somebody asked to disconnect is worse.
  save({
    ...config,
    deviceToken: "",
    lastParsedAt: null,
    lastSyncAt: null,
    files: {},
  });
  console.log(
    revoked
      ? "  Disconnected. The device has been revoked on inlinr.com too."
      : "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.",
  );
  return 0;
}
