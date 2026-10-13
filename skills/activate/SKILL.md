---
name: activate
description: Connect this machine to your Inlinr account
disable-model-invocation: true
---

Run this exact command **in the background** (it waits for the user, which can
take minutes, and a foreground command shows nothing until it ends):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate
```

As soon as it has printed its link and code (a second or two), read its output
and give the user the link and the code right away. Tell them to open the link
and approve it. Then wait for the command to finish and show the rest of its
output.

Do not modify the command, do not guess a different path, and do not offer to
install anything else — there is nothing else to install.
