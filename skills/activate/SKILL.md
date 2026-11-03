---
name: activate
description: Connect this machine to inlinr time tracking. Use when the user asks to activate, connect or set up inlinr, or when inlinr says this machine is not connected.
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

If the machine is already connected (by this plugin, the inlinr extension or
the `inlinr` command), the command says so and only resumes tracking: there is
no link. Only when the user explicitly wants this machine on **another inlinr
account**, add `--replace` to the command: every inlinr plugin on the machine
then moves to the account that approves.

Do not modify the command otherwise, do not guess a different path, and do not offer to
install anything else — there is nothing else to install.
