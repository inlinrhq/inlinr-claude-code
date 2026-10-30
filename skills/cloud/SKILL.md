---
name: cloud
description: Track Claude Code cloud (web) sessions on inlinr. Use when the user asks to track cloud or web sessions, or to connect inlinr in Claude Code on the web.
---

Run this exact command **in the background** (it waits for the user, which can
take minutes, and a foreground command shows nothing until it ends):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate --cloud
```

As soon as it has printed its link and code (a second or two), read its output
and give the user the link and the code right away. Tell them to open the link
and approve it. Then wait for the command to finish.

It ends with one line, `curl -fsSL https://inlinr.com/cloud-setup.sh | sh -s --
in_d_…`. Give the user that line in a code block and tell them, in a few
words, to paste it once into their cloud environment's **Setup script**
(claude.ai/code, the gear beside the environment), and to add `inlinr.com` to
the allowed domains if its network access is Custom. Nothing else is needed:
no variable, no file in any repository, and new versions arrive by themselves.

Never write the line or its token into a file of a repository: it belongs in
the environment's settings only. The same line is also in inlinr's dashboard,
Settings → Editors → Add device.
