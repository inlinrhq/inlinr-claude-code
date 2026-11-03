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
