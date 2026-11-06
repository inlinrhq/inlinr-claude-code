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

## Then the hooks

The plugin itself runs nothing on its own. Once the command has finished
and the machine is connected, tell the user, in these words or close:

> To track your time, inlinr needs Claude Code to run it after each prompt,
> tool call and reply. This adds hooks to your `~/.claude/settings.json`
> that run `~/.inlinr/agents.js` in the background, for every Claude Code
> session on this machine. They send file paths, line counts, token counts,
> model and session id to inlinr.com, never a prompt, a reply or a file's
> content. `/inlinr:deactivate` takes them out.

Ask whether to add them, and only on a yes run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" setup claude-code
```

Show its output. Tracking starts with the next session. If they say no,
tell them nothing is tracked until they run `/inlinr:activate` again and
accept.

Do not modify the commands otherwise, do not guess a different path, and do not offer to
install anything else — there is nothing else to install.
