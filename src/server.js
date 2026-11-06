// Build the Sempera MCP server. `createServer` is transport-agnostic; bin/sempera-mcp.js connects it to stdio.

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SemperaApiError, SemperaConnectionError } from "./client.js";
import { READ_TOOLS, WRITE_TOOLS } from "./tools.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const INSTRUCTIONS_READ = "Sempera tools for one workspace, through the public Sempera API with the user's API key. "
  + "All tools in this session are read-only: nothing here places a call or sends a text.";
const INSTRUCTIONS_WRITE = "Sempera tools for one workspace, through the public Sempera API with the user's API key. "
  + "send_call and send_sms reach real people. Only use them when the user has asked for that exact call or text, "
  + "show the recipient, agent and consent sentence first, and wait for the user's explicit confirmation. Never invent numbers or consent.";

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function errorResult(err) {
  if (err instanceof SemperaApiError) {
    const error = { status: err.status, code: err.code, message: err.message };
    for (const [k, v] of [["reason", err.reason], ["field", err.field], ["scope", err.scope], ["retry_after_s", err.retryAfterSeconds], ["request_id", err.requestId]]) {
      if (v !== undefined && v !== null) error[k] = v;
    }
    return textResult({ error }, true);
  }
  if (err instanceof SemperaConnectionError) {
    const error = { code: "connection_failed", message: err.message };
    if (err.idempotencyKey) {
      error.hint = "The outcome is unknown. Read the call or conversation before retrying, and retry only with the same idempotency_key.";
      error.idempotency_key = err.idempotencyKey;
    }
    return textResult({ error }, true);
  }
  return textResult({ error: { code: typeof err?.code === "string" ? err.code : "invalid_request", message: err?.message ?? String(err) } }, true);
}

/**
 * @param {object} options
 * @param {() => Promise<import("./client.js").SemperaClient>} options.getClient  resolves the API client lazily
 * @param {boolean} [options.allowWrites]  register send_call and send_sms
 */
export function createServer({ getClient, allowWrites = false }) {
  const server = new McpServer(
    { name: "sempera", title: "Sempera", version: VERSION },
    { instructions: allowWrites ? INSTRUCTIONS_WRITE : INSTRUCTIONS_READ },
  );
  const tools = allowWrites ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { title: tool.title, ...tool.annotations } },
      async (args) => {
        try {
          const client = tool.local ? null : await getClient();
          return textResult(await tool.run(client, args ?? {}));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
  return server;
}
