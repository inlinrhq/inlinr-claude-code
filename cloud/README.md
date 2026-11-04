# inlinr-cloud

Install: `/plugin install inlinr-cloud --marketplace inlinrhq/inlinr-claude-code`

The companion of the `inlinr` plugin for Claude Code cloud sessions tracked
through the inlinr connector, with no token anywhere.

1. On claude.ai, Settings → Connectors: add a custom connector named
   `inlinr`, URL `https://inlinr.com/api/mcp`, and allow it on inlinr.com.
2. Install both plugins, `inlinr` and `inlinr-cloud`.

This plugin holds one hook: on each prompt and when Claude stops, it calls the
connector's `claim_session` with the session id (an `mcp_tool` hook). The
`inlinr` plugin then sends the session's time with that id instead of a token.

It is a plugin of its own because a hook that names a connector you have not
added shows "MCP server 'inlinr' not connected" on every turn: install it only
with the connector.
