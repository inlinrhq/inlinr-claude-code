---
name: cloud
description: Track Claude Code cloud (web) sessions on inlinr. Use when the user asks to track cloud or web sessions.
---

Run this exact command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate --cloud
```

It returns at once and prints the steps: get the setup line in inlinr's
Settings → Editors, then paste it into the Setup script of a cloud environment
the user alone uses, on claude.ai/code. Give the user those steps and the link.

The line holds a token. Never ask the user to paste it, or any token, into
this chat, and never write it into a file of the repository: it belongs in the
environment's settings only.
