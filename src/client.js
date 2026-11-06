// A small client for the public Sempera API (https://api.sempera.org, contract at /openapi.json).
//
// This file is shared byte for byte by @sempera/cli and @sempera/mcp. It has no dependencies: it needs the
// global `fetch` of Node 20 or newer. Every route it calls is listed in the published OpenAPI document.

export const DEFAULT_BASE_URL = "https://api.sempera.org";
export const CLIENT_VERSION = "0.1.0";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** A refusal from the API, in the one error envelope `{"error": {"code", "message", "request_id", ...}}`. */
export class SemperaApiError extends Error {
  constructor(status, body, headers = {}) {
    const env = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
    const firstCompat = Array.isArray(body?.errors) && body.errors[0] && typeof body.errors[0] === "object" ? body.errors[0] : {};
    const code = String(env.code ?? firstCompat.error ?? `http_${status}`);
    const message = String(env.message ?? firstCompat.message ?? `HTTP ${status}`);
    super(message);
    this.name = "SemperaApiError";
    this.status = status;
    this.code = code;
    this.requestId = env.request_id ?? headers["x-request-id"];
    this.reason = env.reason;
    this.field = env.field;
    this.scope = env.scope;
    const retryAfter = Number(env.retry_after_s ?? headers["retry-after"]);
    this.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
    this.body = body;
  }
}

/** No answer at all: DNS, TLS, a refused connection or a timeout. Nothing is known about what happened. */
export class SemperaConnectionError extends Error {
  constructor(message, { idempotencyKey } = {}) {
    super(message);
    this.name = "SemperaConnectionError";
    this.idempotencyKey = idempotencyKey;
  }
}

/** A key that names one logical request. The same key on a retry can never act twice. */
export function newIdempotencyKey(prefix = "sempera") {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function required(name, value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

export class SemperaClient {
  /**
   * @param {object} options
   * @param {string} [options.apiKey]      the workspace API key; sent as `Authorization: Bearer <key>`
   * @param {string} [options.baseUrl]     defaults to https://api.sempera.org
   * @param {typeof fetch} [options.fetch] replace the HTTP layer (tests)
   * @param {number} [options.maxRetries]  retries of a safe request, default 2
   * @param {number} [options.timeoutMs]   per attempt, default 30000
   * @param {string} [options.userAgent]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? `sempera-node/${CLIENT_VERSION}`;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One request. GETs are retried on 429, 502, 503 and 504 and on a dropped connection. A write is retried
   * only after a 429, which means it was not processed; any other uncertainty is reported, never retried blind.
   */
  async request(method, path, { query, body, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { Accept: "application/json", "User-Agent": this.userAgent };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const isRead = method === "GET";
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url.toString(), { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        if (isRead && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        const why = cause?.name === "TimeoutError" ? `no answer within ${this.timeoutMs / 1000}s` : (cause?.cause?.code ?? cause?.message ?? String(cause));
        throw new SemperaConnectionError(`could not reach ${this.baseUrl} (${why})`, { idempotencyKey });
      }
      const rheaders = {};
      response.headers.forEach((v, k) => (rheaders[k.toLowerCase()] = v));
      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = response.ok ? text : null;
        }
      }
      if (response.ok) return parsed;
      const error = new SemperaApiError(response.status, parsed, rheaders);
      const retryable = RETRYABLE_STATUS.has(response.status) && !(response.status === 503 && error.code !== "service_unavailable");
      if (retryable && attempt < this.maxRetries && (isRead || response.status === 429)) {
        await this.sleep(this.backoff(attempt, error.retryAfterSeconds));
        continue;
      }
      throw error;
    }
  }

  backoff(attempt, retryAfterSeconds) {
    if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds, 30) * 1000;
    return Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
  }

  // ---------------------------------------------------------------- reads

  /** GET /v1/me: the calling credential (workspace, role, scopes). */
  getMe() {
    return this.request("GET", "/v1/me");
  }

  /** GET /v1/agents. `status` is active (default), archived or all. */
  listAgents({ status, limit, cursor } = {}) {
    return this.request("GET", "/v1/agents", { query: { status, limit, cursor } });
  }

  /** GET /v1/agents/{agent_id} */
  getAgent(agentId) {
    return this.request("GET", `/v1/agents/${encodeURIComponent(required("agent_id", agentId))}`);
  }

  /** GET /v1/calls?agent_id=... newest first. */
  listCalls({ agentId, limit, cursor } = {}) {
    return this.request("GET", "/v1/calls", { query: { agent_id: required("agent_id", agentId), limit, cursor } });
  }

  /** GET /v1/calls/{call_id} */
  getCall(callId, { agentId } = {}) {
    return this.request("GET", `/v1/calls/${encodeURIComponent(required("call_id", callId))}`, { query: { agent_id: agentId } });
  }

  /** GET /v1/phone-numbers?agent_id=... the numbers bound to one agent. */
  listPhoneNumbers({ agentId, limit, cursor } = {}) {
    return this.request("GET", "/v1/phone-numbers", { query: { agent_id: required("agent_id", agentId), limit, cursor } });
  }

  /** GET /v1/sms/numbers: numbers that can send and receive texts. */
  listSmsNumbers() {
    return this.request("GET", "/v1/sms/numbers");
  }

  /** GET /v1/sessions?agent_id=... conversations on every channel (phone, web voice, chat, tests). */
  listConversations({ agentId, channel, limit, cursor } = {}) {
    return this.request("GET", "/v1/sessions", { query: { agent_id: required("agent_id", agentId), channel, limit, cursor } });
  }

  /** GET /v1/sessions/{session_id} */
  getConversation(conversationId, { agentId } = {}) {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(required("conversation_id", conversationId))}`, { query: { agent_id: agentId } });
  }

  // ---------------------------------------------------------------- writes (each one reaches a real person)

  /**
   * POST /v1/calls: place one real outbound phone call. Every argument that decides who is dialed is
   * required and explicit; nothing here falls back to a default number or agent.
   */
  sendCall({ agentId, to, consentBasis, idempotencyKey, mode, message, task, from, voice, language, agentVersion, production, timezone, window, metadata }) {
    required("agent_id", agentId);
    required("to", to);
    required("consent_basis", consentBasis);
    required("idempotency_key", idempotencyKey);
    if (mode === "prompt" && !task) throw new TypeError("task is required when mode is prompt");
    if (mode === "prompt" && (agentVersion !== undefined || production)) throw new TypeError("agent_version and production cannot be sent with mode prompt");
    const body = compact({
      agent_id: agentId, to, consent_basis: consentBasis, mode, message, task, from, voice, language,
      agent_version: agentVersion, production: production ? true : undefined, timezone, window,
    });
    if (metadata && Object.keys(metadata).length) body.metadata = metadata;
    return this.request("POST", "/v1/calls", { body, idempotencyKey });
  }

  /** POST /v1/sms/send: send one real text from an agent's own texting number. */
  sendSms({ agentId, from, to, message, consentBasis, idempotencyKey, timezone, window }) {
    required("agent_id", agentId);
    required("from", from);
    required("to", to);
    required("message", message);
    required("consent_basis", consentBasis);
    required("idempotency_key", idempotencyKey);
    const body = compact({
      agent_id: agentId, agent_number: from, user_number: to, agent_message: message,
      consent_basis: consentBasis, timezone, window,
    });
    return this.request("POST", "/v1/sms/send", { body, idempotencyKey });
  }
}
