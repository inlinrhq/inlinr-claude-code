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
  /** The command that runs this script, in a cloud session; null elsewhere. */
  cloudScript: string | null = null,
): string | null {
  if (!connected && cloudScript) {
    // A cloud container is new each time: what the person needs is the line
    // that connects every later session too, and this one tracked now.
    return [
      "inlinr (time tracking) runs in this Claude Code cloud session but is not connected to an inlinr account, so this session is not tracked.",
      "Mention this to the user once, briefly, at a natural point in your first reply, and offer to connect it.",
      `If they agree, run \`${cloudScript} activate --cloud\` in the background, give them the link and code it prints as soon as they appear, and wait for it to finish.`,
      "Once approved, this session is tracked from then on, and the command prints one line starting with `curl -fsSL`.",
      "Give the user that line in a code block and tell them to paste it once into this cloud environment's Setup script (claude.ai/code, the gear beside the environment), and to add inlinr.com to its allowed domains if its network access is Custom: every later session is then tracked without asking.",
      "Never write that line or its token into a file of the repository.",
    ].join(" ");
  }
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
