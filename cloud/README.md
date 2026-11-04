# inlinr-cloud

Install: `/plugin install inlinr-cloud --marketplace inlinrhq/inlinr-claude-code`

The companion of the `inlinr` plugin for Claude Code cloud sessions tracked
through the inlinr connector, with no token anywhere.

1. On claude.ai, Settings → Connectors: add a custom connector named
   `inlinr`, URL `https://inlinr.com/api/mcp`, and allow it on inlinr.com.
2. Install both plugins, `inlinr` and `inlinr-cloud`.

Its hooks (`mcp_tool`) call the connector's `record_activity`: on each
prompt and when Claude stops, with the session id and its folder, and after
each Edit, Write or MultiEdit, with the file's path, its GitHub repository and
its line counts against the last commit, as Claude Code gives them. claude.ai
makes the call, not the container, so the session is tracked even when its
environment's network access does not allow inlinr.com. Never the file's
content.

When the container does reach inlinr.com, the `inlinr` plugin sends the
session's own beats (tokens, model, branch too) and inlinr.com keeps those
instead.

It is a plugin of its own because a hook that names a connector you have not
added shows "MCP server 'inlinr' not connected" on every turn: install it only
with the connector.
