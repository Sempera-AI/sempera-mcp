// Tests for the Sempera MCP server. A real MCP client talks to the server over an in-memory transport; the
// HTTP layer under the server is a fake `fetch`, so nothing here reaches a network.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SemperaClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { READ_TOOLS, WRITE_TOOLS } from "../src/tools.js";

const KEY = "sempera_sk_test_0000";
const BIN = fileURLToPath(new URL("../bin/sempera-mcp.js", import.meta.url));
const VECTOR = {
  secret: "whsec_vector_0123456789",
  t: 1790000000,
  body: '{"created_at":"2026-09-28T12:00:00+00:00","data":{"actor":"vector","endpoint_id":"22222222-2222-4222-8222-222222222222"},"id":"evt_00000000000000000000000000000001","object":"event","type":"webhook.test","workspace_id":"11111111-1111-4111-8111-111111111111"}',
  header: "t=1790000000,v1=1f4226699ca9fa61b71fbb57dbd2f57efa6788488437ee2e411ea4e3002be3c1",
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const call = { method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const handler = routes[key];
    if (!handler) return json(404, { error: { code: "not_found", message: `no fake for ${key}`, request_id: "req_fake" } });
    return handler(call);
  };
  return { fetch, calls };
}

async function connect({ routes = {}, allowWrites = false, getClient } = {}) {
  const { fetch, calls } = fakeFetch(routes);
  const api = new SemperaClient({ apiKey: KEY, fetch, sleep: async () => {} });
  const server = createServer({ getClient: getClient ?? (async () => api), allowWrites });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, calls };
}

const parse = (result) => JSON.parse(result.content[0].text);

const CALL_ARGS = {
  agent_id: "northwind-barbers",
  to: "+14165550123",
  consent_basis: "This person asked us to call about Friday.",
  idempotency_key: "friday-3pm-ada-0001",
};
const SMS_ARGS = {
  agent_id: "northwind-barbers",
  from: "+14165550199",
  to: "+14165550123",
  message: "See you Friday at 3.",
  consent_basis: "This person asked for a text reminder.",
  idempotency_key: "sms-friday-ada-0001",
};

describe("tool lists", () => {
  test("by default only read tools are offered, each marked read-only with a description", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, READ_TOOLS.map((t) => t.name).sort());
    assert.ok(!names.includes("send_call") && !names.includes("send_sms"));
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.match(t.description, /^Read-only\./, t.name);
    }
  });

  test("--allow-writes adds the two write tools, marked as writes", async () => {
    const { client } = await connect({ allowWrites: true });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name).sort());
    for (const name of ["send_call", "send_sms"]) {
      const t = tools.find((x) => x.name === name);
      assert.equal(t.annotations.readOnlyHint, false);
      assert.equal(t.annotations.openWorldHint, true);
      assert.match(t.description, /^WRITE: /);
      assert.match(t.description, /explicit confirmation/);
    }
  });

  test("write tools require every recipient detail and default nothing", async () => {
    const { client } = await connect({ allowWrites: true });
    const { tools } = await client.listTools();
    const required = {
      send_call: ["agent_id", "to", "consent_basis", "idempotency_key"],
      send_sms: ["agent_id", "from", "to", "message", "consent_basis", "idempotency_key"],
    };
    for (const [name, fields] of Object.entries(required)) {
      const schema = tools.find((t) => t.name === name).inputSchema;
      assert.deepEqual([...schema.required].sort(), [...fields].sort(), name);
      assert.ok(!JSON.stringify(schema).includes('"default"'), `${name} declares a default`);
    }
  });
});

describe("read tools", () => {
  test("list_agents returns the API's answer", async () => {
    const answer = { object: "list", data: [{ id: "northwind-barbers" }], has_more: false };
    const { client, calls } = await connect({ routes: { "GET /v1/agents": () => json(200, answer) } });
    const result = await client.callTool({ name: "list_agents", arguments: { status: "all", limit: 10 } });
    assert.ok(!result.isError);
    assert.deepEqual(parse(result), answer);
    assert.deepEqual(calls[0].query, { status: "all", limit: "10" });
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  });

  test("each read tool calls its own GET route", async () => {
    const routes = {};
    for (const r of ["/v1/me", "/v1/agents/a1", "/v1/calls", "/v1/calls/call-1", "/v1/sessions", "/v1/sessions/ses_1", "/v1/phone-numbers", "/v1/sms/numbers"]) {
      routes[`GET ${r}`] = () => json(200, { ok: r });
    }
    const { client, calls } = await connect({ routes });
    const cases = [
      ["get_credential", {}, "/v1/me"],
      ["get_agent", { agent_id: "a1" }, "/v1/agents/a1"],
      ["list_calls", { agent_id: "a1" }, "/v1/calls"],
      ["get_call", { call_id: "call-1", agent_id: "a1" }, "/v1/calls/call-1"],
      ["list_conversations", { agent_id: "a1", channel: "phone" }, "/v1/sessions"],
      ["get_conversation", { conversation_id: "ses_1" }, "/v1/sessions/ses_1"],
      ["list_phone_numbers", { agent_id: "a1" }, "/v1/phone-numbers"],
      ["list_sms_numbers", {}, "/v1/sms/numbers"],
    ];
    for (const [name, args, path] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`);
      assert.deepEqual(parse(result), { ok: path });
    }
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  test("a bad argument is refused before any request", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({ name: "get_agent", arguments: { agent_id: "../../v1/api-keys" } });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  test("an API refusal is a tool error with the code and request id", async () => {
    const { client } = await connect({ routes: { "GET /v1/calls": () => json(403, { error: { code: "insufficient_scope", message: "no", scope: "calls:read", request_id: "req_1" } }) } });
    const result = await client.callTool({ name: "list_calls", arguments: { agent_id: "a1" } });
    assert.equal(result.isError, true);
    assert.deepEqual(parse(result).error, { status: 403, code: "insufficient_scope", message: "no", scope: "calls:read", request_id: "req_1" });
  });

  test("a missing key is a tool error, not a crash", async () => {
    const { client } = await connect({ getClient: async () => { throw Object.assign(new Error("No Sempera API key."), { code: "authentication_required" }); } });
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.code, "authentication_required");
  });

  test("verify_webhook_signature checks the published known answer locally", async () => {
    const { client, calls } = await connect({ getClient: async () => { throw new Error("must not be called"); } });
    const ok = await client.callTool({ name: "verify_webhook_signature", arguments: { secret: VECTOR.secret, body: VECTOR.body, signature: VECTOR.header, now: VECTOR.t } });
    assert.deepEqual(parse(ok), { valid: true, timestamp: VECTOR.t });
    const bad = await client.callTool({ name: "verify_webhook_signature", arguments: { secret: VECTOR.secret, body: VECTOR.body + "x", signature: VECTOR.header, now: VECTOR.t } });
    assert.equal(parse(bad).valid, false);
    assert.equal(calls.length, 0);
  });
});

describe("write tools", () => {
  test("are not callable without --allow-writes", async () => {
    const { client, calls } = await connect({ routes: { "POST /v1/calls": () => json(201, {}) } });
    const result = await client.callTool({ name: "send_call", arguments: CALL_ARGS });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  test("send_call refuses when any required argument is missing", async () => {
    const { client, calls } = await connect({ allowWrites: true, routes: { "POST /v1/calls": () => json(201, {}) } });
    for (const drop of Object.keys(CALL_ARGS)) {
      const args = { ...CALL_ARGS };
      delete args[drop];
      const result = await client.callTool({ name: "send_call", arguments: args });
      assert.equal(result.isError, true, drop);
    }
    const local = await client.callTool({ name: "send_call", arguments: { ...CALL_ARGS, to: "416-555-0123" } });
    assert.equal(local.isError, true, "a non-E.164 number");
    const prompt = await client.callTool({ name: "send_call", arguments: { ...CALL_ARGS, mode: "prompt" } });
    assert.equal(prompt.isError, true, "prompt mode without a task");
    assert.equal(calls.length, 0);
  });

  test("send_call posts exactly the given call with the given idempotency key", async () => {
    const { client, calls } = await connect({ allowWrites: true, routes: { "POST /v1/calls": () => json(201, { call: { id: "call-9", status: "queued" } }) } });
    const result = await client.callTool({ name: "send_call", arguments: { ...CALL_ARGS, message: "Hello about Friday.", metadata: { name: "Ada" } } });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/v1/calls");
    assert.equal(calls[0].headers["Idempotency-Key"], CALL_ARGS.idempotency_key);
    assert.deepEqual(calls[0].body, {
      agent_id: "northwind-barbers",
      to: "+14165550123",
      consent_basis: CALL_ARGS.consent_basis,
      message: "Hello about Friday.",
      metadata: { name: "Ada" },
    });
    assert.equal(parse(result).call.id, "call-9");
  });

  test("send_sms posts the API's field names and refuses a missing field", async () => {
    const { client, calls } = await connect({ allowWrites: true, routes: { "POST /v1/sms/send": () => json(200, { data: { status: "sent", sent: true }, errors: null }) } });
    const missing = await client.callTool({ name: "send_sms", arguments: { ...SMS_ARGS, message: undefined } });
    assert.equal(missing.isError, true);
    assert.equal(calls.length, 0);
    const result = await client.callTool({ name: "send_sms", arguments: SMS_ARGS });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(calls[0].body, {
      agent_id: "northwind-barbers",
      agent_number: "+14165550199",
      user_number: "+14165550123",
      agent_message: "See you Friday at 3.",
      consent_basis: SMS_ARGS.consent_basis,
    });
    assert.equal(calls[0].headers["Idempotency-Key"], SMS_ARGS.idempotency_key);
  });

  test("a dropped connection on a write is reported with the key, never retried", async () => {
    const { client, calls } = await connect({ allowWrites: true, routes: { "POST /v1/calls": () => { throw new TypeError("fetch failed"); } } });
    const result = await client.callTool({ name: "send_call", arguments: CALL_ARGS });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.idempotency_key, CALL_ARGS.idempotency_key);
    assert.equal(calls.length, 1);
  });
});

describe("packaging", () => {
  test("the shared client files are the same as the CLI's when both are present", async (t) => {
    for (const name of ["client.js", "webhooks.js", "credentials.js"]) {
      const mine = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
      let theirs;
      try {
        theirs = await readFile(new URL(`../../cli/src/${name}`, import.meta.url), "utf8");
      } catch {
        t.skip("the CLI is not checked out beside this package");
        return;
      }
      assert.equal(mine, theirs, `${name} differs from ../cli/src/${name}; copy the CLI's version`);
    }
  });

  test("the stdio binary serves tools/list and a read against a local HTTP server", async () => {
    const seen = [];
    const http = createHttpServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "northwind-barbers" }], has_more: false }));
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const configDir = await mkdtemp(join(tmpdir(), "sempera-mcp-test-"));
    const client = new Client({ name: "test", version: "0" });
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BIN],
        env: { PATH: process.env.PATH ?? "", SEMPERA_API_KEY: KEY, SEMPERA_BASE_URL: `http://127.0.0.1:${http.address().port}`, SEMPERA_CONFIG_DIR: configDir, SEMPERA_NO_KEYCHAIN: "1" },
        stderr: "pipe",
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "list_agents"));
      assert.ok(!tools.some((t) => t.name === "send_call"));
      const result = await client.callTool({ name: "list_agents", arguments: {} });
      assert.equal(parse(result).data[0].id, "northwind-barbers");
      assert.deepEqual(seen, [{ url: "/v1/agents", auth: `Bearer ${KEY}` }]);
    } finally {
      await client.close();
      http.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
