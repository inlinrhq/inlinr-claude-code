---
description: Check whether Inlinr tracking is working on this machine
---

Run this exact command and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" status
```

It reports which build is running, whether this machine is connected, when a
sync last happened, and how many transcripts are in scope.

If it says the plugin is not connected, tell them to run `/inlinr:activate`.
If the version looks older than they expect, the plugin cache is keyed by
version and will not re-fetch one it already has — `claude plugin update
inlinr@inlinr`, and if that changes nothing, uninstall and install again.
