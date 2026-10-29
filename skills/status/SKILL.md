---
name: status
description: Check whether inlinr time tracking works on this machine, and update the plugin. Use when the user types /inlinr or asks whether inlinr is tracking, its status, or to update it.
---

Run this exact command and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" status
```

It reports which build is running, whether this machine is connected, when a
sync last happened, and how many transcripts are in scope.

If it says the plugin is not connected, offer to connect it with the
inlinr:activate skill.

If the user asks to update the plugin, or the version looks older than they
expect, run:

```bash
claude plugin marketplace update inlinr && claude plugin update inlinr@inlinr
```

The plugin cache is keyed by version and will not re-fetch one it already has,
so if that changes nothing, run `claude plugin uninstall inlinr@inlinr` then
`claude plugin install inlinr@inlinr --scope user`. If the `claude` command is
not available (the desktop app does not always put it on the PATH), tell them
to open the `/plugin` menu, pick the inlinr marketplace and choose Update.
Either way the new version applies to the next session, not this one.
