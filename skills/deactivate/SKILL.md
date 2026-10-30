---
name: deactivate
description: Disconnect this machine from your inlinr account
disable-model-invocation: true
---

Run this exact command and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" deactivate
```

It removes the local token and revokes the device on inlinr.com, so tracking
stops from this machine. The token is shared by every inlinr plugin on the
machine, so the VS Code extension and the `inlinr` command are signed out too. Their history is untouched — this disconnects a
machine, it does not delete anything.

To connect again later, they run `/inlinr:activate`.
