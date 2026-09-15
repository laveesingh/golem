// Harness-neutral HTTP client for Golem's dashboard-owned APIs.
//
// Adapters inject transport discovery and trusted caller identity. This module
// deliberately does not inspect process environment, session registries, or
// model-supplied arguments.

import fs from 'node:fs';

export class GolemClientError extends Error {
  constructor(message, {
    code = 'GOLEM_REQUEST_FAILED',
    retryable = false,
    status = null,
    method = null,
    pathname = null,
    operationId = null,
    body = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GolemClientError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.method = method;
    this.pathname = pathname;
    this.operationId = operationId;
    // The server's owned error payload (machine code + recovery fields such as
    // current revision/outline) for callers that map conflicts onto recovery.
    this.body = body;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      method: this.method,
      pathname: this.pathname,
      ...(this.operationId ? { operation_id: this.operationId } : {}),
    };
  }
}

export function resolveGolemDashboardBaseUrl({ dashboardFile } = {}) {
  const fallback = 'http://dashboard.golem.localhost:7420';
  if (!dashboardFile) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(dashboardFile, 'utf8'));
    if (typeof value?.url === 'string' && value.url.trim()) return value.url.replace(/\/+$/, '');
    if (value?.host && value?.port) return `http://${value.host}:${value.port}`;
  } catch {}
  return fallback;
}

function requireNonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GolemClientError(`${label} is required`, {
      code: 'GOLEM_INVALID_ARGUMENT',
      retryable: false,
    });
  }
  return value.trim();
}

function serverError(parsed, response) {
  if (parsed && typeof parsed === 'object' && parsed.error != null) return parsed.error;
  if (typeof parsed === 'string' && parsed) return parsed;
  return response.statusText;
}

export function createGolemClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  callerSessionId = null,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new GolemClientError('createGolemClient: baseUrl is required', {
      code: 'GOLEM_INVALID_ARGUMENT',
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new GolemClientError('createGolemClient: fetchImpl must be a function', {
      code: 'GOLEM_INVALID_ARGUMENT',
    });
  }
  let root;
  try {
    root = new URL(baseUrl).toString().replace(/\/+$/, '');
  } catch (cause) {
    throw new GolemClientError(`createGolemClient: invalid baseUrl — ${cause?.message ?? cause}`, {
      code: 'GOLEM_INVALID_ARGUMENT',
      retryable: false,
      cause,
    });
  }

  const request = async (method, pathname, {
    params,
    body,
    requiredBodyFields = [],
    verbatimError = false,
    caller_session_id = callerSessionId,
    timeoutMs = null,
  } = {}) => {
    const url = new URL(pathname, root);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    for (const field of requiredBodyFields) {
      if (typeof body?.[field] !== 'string' || !body[field].trim()) {
        throw new GolemClientError(
          `tracker transport invariant failed: ${method} ${pathname} requires nonblank ${field}`,
          { code: 'GOLEM_INVALID_ARGUMENT', method, pathname },
        );
      }
    }

    const headers = { 'X-Sender': 'cli' };
    if (caller_session_id) headers['X-Golem-Caller-Session'] = caller_session_id;
    const init = { method, headers };
    if (timeoutMs != null) init.signal = AbortSignal.timeout(timeoutMs);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (cause) {
      throw new GolemClientError(
        `tracker request failed: ${method} ${url} — ${cause?.message ?? cause}. Is the golem dashboard running? (dashboardBaseUrl=${root})`,
        { code: 'GOLEM_TRANSPORT_ERROR', retryable: true, method, pathname, cause },
      );
    }

    let text;
    try {
      text = await response.text();
    } catch (cause) {
      throw new GolemClientError(
        `tracker response failed: ${method} ${url} — ${cause?.message ?? cause}`,
        { code: 'GOLEM_TRANSPORT_ERROR', retryable: true, status: response.status ?? null, method, pathname, cause },
      );
    }
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!response.ok) {
      const detail = String(serverError(parsed, response));
      const message = verbatimError ? detail : `tracker ${method} ${pathname} → ${response.status} ${detail}`;
      throw new GolemClientError(message, {
        code: pathname === '/api/messages/notify' && typeof parsed?.code === 'string' ? parsed.code : 'GOLEM_HTTP_ERROR',
        operationId: parsed?.operation_id ?? null,
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
        method,
        pathname,
        body: parsed && typeof parsed === 'object' ? parsed : null,
      });
    }
    return parsed;
  };

  return Object.freeze({
    request,
    listTickets: (params = {}) => request('GET', '/api/tickets', { params }),
    getTicket: (id) => request('GET', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'getTicket: id'))}`),
    // GOL-326: HTML outline / block reads / atomic block patches (REST boundary).
    getTicketOutline: (id) => request('GET', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'getTicketOutline: id'))}/outline`),
    getTicketBlock: (id, blockId) => request('GET', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'getTicketBlock: id'))}/blocks/${encodeURIComponent(requireNonblank(blockId, 'getTicketBlock: blockId'))}`),
    patchTicketBlocks: (id, body) => request('POST', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'patchTicketBlocks: id'))}/block-patches`, { body }),
    createTicket: (body = {}) => request('POST', '/api/tickets', { body, requiredBodyFields: ['project_id'] }),
    updateTicket: (id, body) => request('PATCH', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'updateTicket: id'))}`, { body }),
    addComment: (id, body) => request('POST', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'addComment: id'))}/comments`, { body }),
    updateComment: (id, commentId, body) => request('PATCH', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'updateComment: id'))}/comments/${encodeURIComponent(requireNonblank(commentId, 'updateComment: commentId'))}`, { body }),
    replyComment: (id, commentId, body) => request('POST', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'replyComment: id'))}/comments/${encodeURIComponent(requireNonblank(commentId, 'replyComment: commentId'))}/reply`, { body }),
    dispatchTicket: (id, body) => request('POST', `/api/tickets/${encodeURIComponent(requireNonblank(id, 'dispatchTicket: id'))}/dispatch`, { body }),
    listDispatchable: (project) => request('GET', '/api/sessions/dispatchable', { params: project ? { project } : {} }),
    postBrief: (sessionId, text) => request('POST', '/api/brief', { body: { session_id: requireNonblank(sessionId, 'postBrief: sessionId'), text } }),
    notifySession: (body) => request('POST', '/api/messages/notify', { body, timeoutMs: 40_000 }),
    deliverControlMessage: (body) => request('POST', '/api/messages/control', { body }),
    acknowledgeEnvelope: (id, body) => request('POST', `/api/message-envelopes/${encodeURIComponent(requireNonblank(id, 'acknowledgeEnvelope: id'))}/ack`, { body, caller_session_id: body?.target_session_id }),
  });
}
