---
description: Track Claude Code cloud sessions on Inlinr too
---

Run this exact command and show the user its full output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" activate --cloud
```

It prints a link and a code, then waits. Tell the user to open the link and
approve it; the command finishes on its own once they do, and prints the three
steps that make cloud sessions report to Inlinr: an environment variable, a
network allowlist entry, and a hook to add to each repository's
`.claude/settings.json`.

Cloud sessions do not install plugins, which is why the hook goes in the
repository. Offer to add that block to this repository's
`.claude/settings.json`, merging it with any hooks already there. Do not write
the token into any file in the repository: it belongs in the environment's
settings only.
