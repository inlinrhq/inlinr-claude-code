# inlinr-cloud

Install: download it from https://inlinr.com/inlinr-cloud.zip and upload it
to the plugins of your claude.ai account. Anthropic's plugin directory accepts
`mcp_tool` hooks only from organizations it has verified, so the plugin is not
listed there. inlinr.com builds that zip from its own copy of these files
(`src/lib/cloud/companion.ts` in inlinr-web): change both together.

The companion of the `inlinr` plugin for Claude Code cloud sessions tracked
through the inlinr connector, with no token anywhere.

1. On claude.ai, Settings → Connectors: add a custom connector named
   `inlinr`, URL `https://inlinr.com/api/mcp`, and allow it on inlinr.com.
2. Upload `inlinr-cloud` to your claude.ai account (above).

Its hooks (`mcp_tool`) call the connector's `record_activity`: on each
prompt and when Claude stops, with the session id and its folder, and after
each Edit, Write or MultiEdit, with the file's path, its GitHub repository and
its line counts against the last commit, as Claude Code gives them. claude.ai
makes the call, not the container, so the session is tracked even when its
environment's network access does not allow inlinr.com. Never the file's
content.

When inlinr.com's setup line also runs in the environment (its network must
allow inlinr.com), it sends the session's own beats (tokens, model, branch
too) and inlinr.com keeps those instead.

It is a plugin of its own because a hook that names a connector you have not
added shows "MCP server 'inlinr' not connected" on every turn: install it only
with the connector.
