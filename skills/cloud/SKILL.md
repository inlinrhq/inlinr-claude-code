---
name: cloud
description: Track Claude Code cloud sessions on Inlinr too
disable-model-invocation: true
---

Run this exact command **in the background** (it waits for the user, which can
take minutes, and a foreground command shows nothing until it ends):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate --cloud
```

As soon as it has printed its link and code (a second or two), read its output
and give the user the link and the code right away. Tell them to open the link
and approve it. Then wait for the command to finish and show the rest of its
output.

Once it finishes it prints the three steps that make cloud sessions report to
Inlinr: an environment variable, a network allowlist entry, and a hook to add
to each repository's `.claude/settings.json`.

Cloud sessions do not install plugins, which is why the hook goes in the
repository. Offer to add that block to this repository's
`.claude/settings.json`, merging it with any hooks already there. Do not write
the token into any file in the repository: it belongs in the environment's
settings only.
