#!/usr/bin/env node
// Sempera MCP server over stdio. stdout carries the protocol; every log line goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DEFAULT_BASE_URL, SemperaClient } from "../src/client.js";
import { loadKeychain, resolveApiKey } from "../src/credentials.js";
import { VERSION, createServer } from "../src/server.js";

const HELP = `sempera-mcp ${VERSION}: the Sempera API as Model Context Protocol tools, over stdio

Usage: sempera-mcp [--allow-writes]

  --allow-writes   Also offer send_call and send_sms, which reach real people.
                   Off by default; SEMPERA_MCP_ALLOW_WRITES=1 does the same.
  -h, --help       This help
  -v, --version    The version

Environment
  SEMPERA_API_KEY    The workspace API key. Without it, the key saved by \`sempera login\` is used.
  SEMPERA_BASE_URL   API base URL (default ${DEFAULT_BASE_URL})
`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.includes("-v") || args.includes("--version")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--allow-writes");
if (unknown.length) {
  process.stderr.write(`sempera-mcp: unknown argument ${unknown[0]}\n\n${HELP}`);
  process.exit(2);
}

const allowWrites = args.includes("--allow-writes") || process.env.SEMPERA_MCP_ALLOW_WRITES === "1";
let client;
async function getClient() {
  if (client) return client;
  const found = await resolveApiKey({ env: process.env, keychain: await loadKeychain(process.env), warn: (s) => process.stderr.write(s + "\n") });
  if (!found) {
    throw Object.assign(new Error("No Sempera API key. Set SEMPERA_API_KEY in this server's MCP config, or run `sempera login` on this machine."), { code: "authentication_required" });
  }
  client = new SemperaClient({ apiKey: found.key, baseUrl: process.env.SEMPERA_BASE_URL || DEFAULT_BASE_URL, userAgent: `sempera-mcp/${VERSION}` });
  return client;
}

const server = createServer({ getClient, allowWrites });
await server.connect(new StdioServerTransport());
process.stderr.write(`sempera-mcp ${VERSION} ready on stdio (${allowWrites ? "read and write tools" : "read-only tools"})\n`);
