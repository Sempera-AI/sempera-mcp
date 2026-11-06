# Sempera MCP server

[Documentation](https://docs.sempera.org) | [MCP guide](https://docs.sempera.org/mcp) | [OpenAPI document](https://api.sempera.org/openapi.json) | [MIT licence](LICENSE)

`@sempera/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for the [Sempera](https://sempera.org) API. It runs on your machine over stdio and lets an AI assistant (Claude Desktop, Claude Code, Cursor, VS Code and other MCP clients) read your AI phone agents, calls, conversations and numbers, and, only if you turn it on, place a call or send a text.

It calls the public API at `https://api.sempera.org` (contract: [`/openapi.json`](https://api.sempera.org/openapi.json)) with your workspace API key. Sempera also hosts an MCP endpoint at `https://api.sempera.org/v1/mcp` for clients that connect over HTTP; this package is the local, stdio alternative.

## Install

Node.js 20 or newer.

```bash
# From npm, once the package is published (MCP clients usually run it with npx, below)
npm install -g @sempera/mcp

# From source, today
git clone https://github.com/Sempera-AI/sempera-mcp.git
cd sempera-mcp
npm install
```

Create an API key in the Sempera App under Settings, API keys. Give the key only the scopes you want the assistant to have.

## Configure your MCP client

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and most other clients use this shape:

```json
{
  "mcpServers": {
    "sempera": {
      "command": "npx",
      "args": ["-y", "@sempera/mcp"],
      "env": { "SEMPERA_API_KEY": "<your API key>" }
    }
  }
}
```

From a source checkout, use `"command": "node"` and `"args": ["/path/to/sempera-mcp/bin/sempera-mcp.js"]`.

Claude Code:

```bash
claude mcp add sempera --env SEMPERA_API_KEY=<your API key> -- npx -y @sempera/mcp
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "sempera": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sempera/mcp"],
      "env": { "SEMPERA_API_KEY": "<your API key>" }
    }
  }
}
```

If you have run `sempera login` with the [Sempera CLI](https://github.com/Sempera-AI/sempera-cli) on the same machine, you can leave `SEMPERA_API_KEY` out: the server reads the same saved key (OS keychain, or the `0600` config file).

## Tools

Read tools are always on. None of them changes anything or contacts anyone.

| Tool | What it returns | API |
|---|---|---|
| `get_credential` | The key's workspace, role and scopes | `GET /v1/me` |
| `list_agents` | Agents, with status and published version | `GET /v1/agents` |
| `get_agent` | One agent in full | `GET /v1/agents/{agent_id}` |
| `list_calls` | One agent's phone calls, newest first | `GET /v1/calls` |
| `get_call` | One call, with its transcript when there is one | `GET /v1/calls/{call_id}` |
| `list_conversations` | One agent's conversations on every channel | `GET /v1/sessions` |
| `get_conversation` | One conversation with its transcript | `GET /v1/sessions/{session_id}` |
| `list_phone_numbers` | Numbers bound to one agent | `GET /v1/phone-numbers` |
| `list_sms_numbers` | Numbers that can send texts | `GET /v1/sms/numbers` |
| `verify_webhook_signature` | Whether an `X-Sempera-Signature` header matches a body and secret (local, no request) | none |

Write tools are off unless you start the server with `--allow-writes` (or set `SEMPERA_MCP_ALLOW_WRITES=1`):

| Tool | What it does | API |
|---|---|---|
| `send_call` | Places one real outbound phone call | `POST /v1/calls` |
| `send_sms` | Sends one real text message | `POST /v1/sms/send` |

```json
"args": ["-y", "@sempera/mcp", "--allow-writes"]
```

The write tools have no defaults. Every call must name the agent, the recipient in E.164 form, a consent sentence saying why the person agreed to be contacted, and an idempotency key (`send_sms` also needs the sending number and the exact message). Their descriptions tell the assistant to show you the details and wait for your confirmation, and they are marked as non-read-only so MCP clients ask before running them. The API still applies calling and sending hours, the do-not-contact list, opt-outs, caps and billing, and sending needs an owner key with the `calls:write` scope. Reusing the same idempotency key replays the first answer instead of contacting the person twice.

Answers are the API's JSON. Call and conversation reads can include transcripts and phone numbers, as the key's scopes allow. A refusal comes back as a tool error carrying the API's `code`, `message` and `request_id`.

## Environment

| Variable | Use |
|---|---|
| `SEMPERA_API_KEY` | The API key; overrides a saved one |
| `SEMPERA_BASE_URL` | Another API base URL |
| `SEMPERA_MCP_ALLOW_WRITES` | `1` to offer `send_call` and `send_sms` |
| `SEMPERA_CONFIG_DIR` | Where a key saved by `sempera login` lives |
| `SEMPERA_NO_KEYCHAIN` | `1` to never use the OS keychain |

## Development

```bash
npm install
npm test        # a real MCP client against the server; the HTTP layer is mocked
npx @modelcontextprotocol/inspector node bin/sempera-mcp.js   # try it by hand
```

`src/client.js`, `src/webhooks.js` and `src/credentials.js` are shared with the Sempera CLI and kept identical to it.

This repository is published from Sempera's main source tree; open issues and pull requests here and they are carried back.

## License

MIT. Copyright (c) 2026 Sempera Labs, Inc. See the LICENSE file.
