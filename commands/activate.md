---
description: Connect this machine to your Inlinr account
---

Run this exact command and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate
```

It prints a link and a code, then waits. Tell the user to open the link and
approve it; the command finishes on its own once they do.

Do not modify the command, do not guess a different path, and do not offer to
install anything else — there is nothing else to install.
