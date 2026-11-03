---
name: deactivate
description: Stop inlinr tracking on this machine, for Claude Code only or for the whole machine
disable-model-invocation: true
---

The connection is the machine's, shared with the inlinr extension for VS Code
(Cursor, Windsurf) and the `inlinr` command. Stopping means one of two things,
so first ask the user which one they want, in these words:

- **Pause Claude Code here**: Claude Code, Codex and Gemini CLI are no longer
  tracked on this machine; the extension keeps tracking. Nothing is revoked.
- **Disconnect this machine**: the token is revoked on inlinr.com and every
  inlinr plugin on the machine stops.

Then run this exact command, with `--pause` or `--machine` for their answer,
and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" deactivate --pause
```

Their history is untouched either way: this stops tracking, it does not
delete anything. `/inlinr:activate` resumes after a pause, or connects the
machine again.
