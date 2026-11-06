// The Sempera MCP tools. Read tools and write tools are two separate lists: the server registers the write
// list only when it is started with --allow-writes (or SEMPERA_MCP_ALLOW_WRITES=1).
//
// Every write reaches a real person. Its schema has no defaults: the agent, the recipient, the consent
// sentence and the idempotency key must all be given by the caller on every call.

import { z } from "zod";

import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from "./webhooks.js";

const id = (what) => z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, `${what} may contain letters, digits, . _ : and -`);
const limit = z.number().int().min(1).max(200).optional().describe("Page size, 1 to 200 (the API's default is 50)");
const cursor = z.string().min(1).max(2000).optional().describe("Pass next_cursor from the previous page, unchanged, to read the next one");
const e164 = (what) => z.string().regex(/^\+[1-9][0-9]{6,14}$/, `${what} must be an E.164 number such as +14165550123`);
const idempotencyKey = z.string().min(8).max(255).describe(
  "A unique key for this one intended action, for example a fresh UUID. Reuse it only to retry the very same request after a timeout; a different request with the same key is refused.",
);
const timezone = z.string().min(1).max(64).optional().describe("Recipient IANA time zone, for example America/Toronto (the API's default)");
const window = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "window is HH:MM-HH:MM").optional().describe("Recipient hours, HH:MM-HH:MM (the API's default is 09:00-18:00); outside them nothing is sent");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

/** Tools that only read. None of them changes anything or contacts anyone. */
export const READ_TOOLS = [
  {
    name: "get_credential",
    title: "Who am I",
    description: "Read-only. Describes the API key this server uses: its workspace, role and scopes (GET /v1/me). Use it to check access before other tools.",
    inputSchema: {},
    annotations: READ,
    run: (c) => c.getMe(),
  },
  {
    name: "list_agents",
    title: "List agents",
    description: "Read-only. Lists the workspace's AI phone agents with their id, name, status and published version (GET /v1/agents). Use an agent's id with the other tools.",
    inputSchema: { status: z.enum(["active", "archived", "all"]).optional().describe("active (the API's default), archived or all"), limit, cursor },
    annotations: READ,
    run: (c, a) => c.listAgents({ status: a.status, limit: a.limit, cursor: a.cursor }),
  },
  {
    name: "get_agent",
    title: "Get an agent",
    description: "Read-only. Returns one agent in full: status, channels, voice, language, instructions, tools, knowledge and draft (GET /v1/agents/{agent_id}).",
    inputSchema: { agent_id: id("agent_id") },
    annotations: READ,
    run: (c, a) => c.getAgent(a.agent_id),
  },
  {
    name: "list_calls",
    title: "List calls",
    description: "Read-only. Lists one agent's phone calls, newest first, with status, direction, times and outcome (GET /v1/calls).",
    inputSchema: { agent_id: id("agent_id"), limit, cursor },
    annotations: READ,
    run: (c, a) => c.listCalls({ agentId: a.agent_id, limit: a.limit, cursor: a.cursor }),
  },
  {
    name: "get_call",
    title: "Get a call",
    description: "Read-only. Returns one phone call: numbers, direction, status, duration and, when recorded, the transcript (GET /v1/calls/{call_id}). The answer can contain personal information about the caller.",
    inputSchema: { call_id: id("call_id"), agent_id: id("agent_id").optional().describe("Narrows the lookup to one agent") },
    annotations: READ,
    run: (c, a) => c.getCall(a.call_id, { agentId: a.agent_id }),
  },
  {
    name: "list_conversations",
    title: "List conversations",
    description: "Read-only. Lists one agent's conversations on every channel (phone, web voice, web chat, API chat, simulator, test), newest first (GET /v1/sessions).",
    inputSchema: {
      agent_id: id("agent_id"),
      channel: z.enum(["phone", "web_voice", "web_chat", "api_chat", "simulator", "test"]).optional().describe("Only this channel"),
      limit,
      cursor,
    },
    annotations: READ,
    run: (c, a) => c.listConversations({ agentId: a.agent_id, channel: a.channel, limit: a.limit, cursor: a.cursor }),
  },
  {
    name: "get_conversation",
    title: "Get a conversation",
    description: "Read-only. Returns one conversation with its transcript (turns), tool timeline, captured variables, outcome and the agent version that spoke (GET /v1/sessions/{session_id}). The answer can contain personal information.",
    inputSchema: { conversation_id: id("conversation_id"), agent_id: id("agent_id").optional().describe("Narrows the lookup to one agent") },
    annotations: READ,
    run: (c, a) => c.getConversation(a.conversation_id, { agentId: a.agent_id }),
  },
  {
    name: "list_phone_numbers",
    title: "List phone numbers",
    description: "Read-only. Lists the phone numbers bound to one agent (GET /v1/phone-numbers).",
    inputSchema: { agent_id: id("agent_id"), limit, cursor },
    annotations: READ,
    run: (c, a) => c.listPhoneNumbers({ agentId: a.agent_id, limit: a.limit, cursor: a.cursor }),
  },
  {
    name: "list_sms_numbers",
    title: "List texting numbers",
    description: "Read-only. Lists the numbers that can send and receive text messages, with the agent that answers each and its thread count (GET /v1/sms/numbers). The sender for send_sms must be one of these.",
    inputSchema: {},
    annotations: READ,
    run: (c) => c.listSmsNumbers(),
  },
  {
    name: "verify_webhook_signature",
    title: "Verify a webhook signature",
    description: "Read-only. Local: no request is made. Checks an X-Sempera-Signature header (t=<unix seconds>,v1=<hex>) against the exact raw body and the endpoint secret. Returns {valid, reason}.",
    inputSchema: {
      secret: z.string().min(1).describe("The webhook endpoint's signing secret"),
      body: z.string().describe("The raw request body, exactly as received"),
      signature: z.string().min(1).describe("The X-Sempera-Signature header value"),
      tolerance_seconds: z.number().int().min(0).max(86400).optional().describe(`Allowed clock difference (default ${DEFAULT_TOLERANCE_SECONDS})`),
      now: z.number().int().min(0).optional().describe("Unix seconds to check against instead of the clock, to replay a captured delivery"),
    },
    annotations: READ,
    local: true,
    run: (_c, a) => verifySignature(a.secret, a.body, a.signature, { toleranceSeconds: a.tolerance_seconds, now: a.now }),
  },
];

/** Tools that reach a real person. Registered only with --allow-writes. */
export const WRITE_TOOLS = [
  {
    name: "send_call",
    title: "Place a real phone call",
    description:
      "WRITE: places ONE real outbound phone call to a real person (POST /v1/calls). Nothing is defaulted: agent_id, to, consent_basis and idempotency_key are all required. "
      + "Before calling this tool, show the user the agent, the number and the consent sentence and get their explicit confirmation. Never guess or invent a number or a consent basis. "
      + "The API still enforces calling hours, the do-not-contact list, outbound caps and billing, and needs an owner key with calls:write. "
      + "If the result is uncertain (a timeout), read the call before retrying, and retry only with the same idempotency_key.",
    inputSchema: {
      agent_id: id("agent_id").describe("The agent whose line places the call"),
      to: e164("to").describe("The recipient, in E.164 form"),
      consent_basis: z.string().min(10).max(500).describe("One sentence recording why this person agreed to be called, as the user stated it"),
      idempotency_key: idempotencyKey,
      message: z.string().min(1).max(500).optional().describe("Opening line after the automated-call disclosure"),
      mode: z.enum(["agent", "prompt"]).optional().describe("agent (the API's default): the published agent talks. prompt: task is the whole conversation"),
      task: z.string().min(1).max(4000).optional().describe("What the call should accomplish; required with mode prompt"),
      from: e164("from").optional().describe("An owned caller id"),
      voice: z.string().min(1).max(200).optional().describe("A Sempera voice id"),
      language: z.string().min(2).max(20).optional(),
      agent_version: z.union([z.string().min(1).max(200), z.number().int().min(1)]).optional().describe("A published version id or number; not with mode prompt"),
      production: z.boolean().optional().describe("Use the production pin explicitly; not with mode prompt"),
      timezone,
      window,
      metadata: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.string().max(200)).optional().describe("Opening-template values such as {\"name\": \"Ada\"}"),
    },
    annotations: WRITE,
    run: (c, a) => c.sendCall({
      agentId: a.agent_id, to: a.to, consentBasis: a.consent_basis, idempotencyKey: a.idempotency_key, message: a.message,
      mode: a.mode, task: a.task, from: a.from, voice: a.voice, language: a.language, agentVersion: a.agent_version,
      production: a.production, timezone: a.timezone, window: a.window, metadata: a.metadata,
    }),
  },
  {
    name: "send_sms",
    title: "Send a real text message",
    description:
      "WRITE: sends ONE real text message to a real person (POST /v1/sms/send) from an agent's own texting number. Nothing is defaulted: agent_id, from, to, message, consent_basis and idempotency_key are all required. "
      + "Before calling this tool, show the user the recipient and the exact message and get their explicit confirmation. Never guess or invent a number or a consent basis. "
      + "The API still enforces sending hours, quiet hours, opt-outs, the do-not-contact list and limits, and needs an owner key with calls:write. "
      + "status \"sent\" means the carrier accepted the text, not that it was delivered.",
    inputSchema: {
      agent_id: id("agent_id").describe("The agent sending the text; texting must be on in its phone setup"),
      from: e164("from").describe("The agent's texting number, from list_sms_numbers"),
      to: e164("to").describe("The recipient, in E.164 form"),
      message: z.string().min(1).max(1600).describe("The exact text to send"),
      consent_basis: z.string().min(10).max(500).describe("One sentence recording why this person agreed to receive texts, as the user stated it"),
      idempotency_key: idempotencyKey,
      timezone,
      window,
    },
    annotations: WRITE,
    run: (c, a) => c.sendSms({
      agentId: a.agent_id, from: a.from, to: a.to, message: a.message, consentBasis: a.consent_basis,
      idempotencyKey: a.idempotency_key, timezone: a.timezone, window: a.window,
    }),
  },
];
