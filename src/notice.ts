/**
 * Tell Claude, at the start of a session, when tracking is not working.
 *
 * The desktop app has no terminal and its users never see a hook's stderr, so
 * a machine that was never activated, or whose device was revoked, used to
 * track nothing in complete silence. Whatever this prints on SessionStart is
 * added to Claude's context; Claude then mentions it and offers the fix. It
 * prints nothing when all is well, and never touches the network.
 */
export function sessionNotice(
  connected: boolean,
  lastLogLine: string | null,
  now = Date.now(),
): string | null {
  if (!connected) {
    return [
      "inlinr (time tracking plugin) is installed but this machine is not connected to an inlinr account, so nothing is being tracked.",
      "Mention this to the user once, briefly, at a natural point in your first reply, and offer to connect it.",
      "If they agree, use the inlinr:activate skill.",
    ].join(" ");
  }
  const m = lastLogLine?.match(/^(\S+) .*HTTP 401/);
  if (m?.[1]) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && now - at < 48 * 3600 * 1000) {
      return [
        "inlinr (time tracking plugin) is installed but inlinr.com refused this machine's token: the device was probably removed from the account, so nothing is being tracked.",
        "Mention this to the user once, briefly, and offer to reconnect it with the inlinr:activate skill.",
      ].join(" ");
    }
  }
  return null;
}

/**
 * The same, in a Claude Code cloud session: the plugin came from the
 * claude.ai account, or a setup line put it there. Never a token in the
 * text, which goes into the session's transcript: the line is made on
 * inlinr.com. `refused` is a line revoked, or bound to another claude.ai
 * account. With no token and inlinr-cloud installed, nothing is said: the
 * session is tracked once its hook claims it.
 */
export function cloudNotice(
  state: "no-token" | "refused",
  settingsUrl: string,
): string {
  const why =
    state === "refused"
      ? "inlinr.com refused this cloud environment's setup line (revoked, or made by another claude.ai account), so this session is not tracked."
      : "this Claude Code cloud session is not tracked by inlinr (time tracking): its environment has no inlinr setup line, and the inlinr-cloud plugin is not installed.";
  const line = `open ${settingsUrl}, choose Add device then Get the setup line, and paste it into the Setup script of this cloud environment (claude.ai/code, the gear beside the environment), adding inlinr.com to its allowed domains if its network access is Custom.`;
  return [
    `inlinr: ${why}`,
    "Mention this to the user once, briefly, at a natural point in your first reply.",
    state === "refused"
      ? `To track this environment again: ${line}`
      : [
          "Two ways to track it.",
          `If you have a tool from an MCP server named inlinr (claim_session), the inlinr connector is already added: the user only needs to add the inlinr-cloud plugin to their claude.ai account, next to this one (from the inlinr marketplace, github.com/inlinrhq/inlinr-claude-code), and every cloud session is tracked with no token.`,
          `Otherwise, either add the inlinr connector on claude.ai (Settings, Connectors, a custom connector named inlinr with the URL https://inlinr.com/api/mcp) and install inlinr-cloud, or ${line}`,
        ].join(" "),
    "Never ask the user to paste the line or a token into this chat.",
  ].join(" ");
}

/**
 * Said once, at the first session tracked with a connection this plugin did
 * not make: the inlinr extension or CLI signed the machine in, and this
 * plugin follows. Tracking somebody's assistant sessions because another
 * plugin was connected is what they asked for, but not something to do
 * without a word.
 */
export function sharedConnectionNotice(): string {
  return [
    "inlinr (time tracking plugin) now tracks Claude Code sessions on this machine, using the connection the inlinr extension or CLI made here (one connection per machine).",
    "Mention this to the user once, briefly, in your first reply.",
    "If they do not want Claude Code tracked here, run the inlinr:deactivate skill and choose to pause; the extension keeps tracking.",
  ].join(" ");
}
