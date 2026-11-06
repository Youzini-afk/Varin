import type { RequestHandler } from 'express';
import { isAllowedObservationRequest } from '@varin/application-client';

// POST is also the Thread query transport. Keep the existing read and explicit
// cancellation plane available; unknown/new commands fail closed while draining.
const threadReads = new Set([
  'materials/read', 'materials/collection', 'materials/read-source', 'materials/read-artifact', 'media/read',
  'computer/state', 'research/scopes', 'research/list', 'research/get', 'research/logs', 'research/artifact',
  'research/resources', 'research/sources', 'process/terminal', 'mcp/interactions/list', 'mcp/interactions/read',
  'source/files', 'source/draft-files', 'source/list', 'context/history', 'history/file',
  'messages/list', 'messages/feed', 'messages/get', 'family/list', 'family/runs', 'family/read', 'family/item',
  'child/executions', 'child/execution/report', 'child/report', 'child/list', 'child/page',
  'resources/draft-skills', 'resources/skills', 'followup/jobs', 'followup/registrations/pending',
  'followup/occurrence', 'followup/occurrences', 'followup/get', 'followup/list', 'goal/list', 'plan/read',
  'tree', 'tree/preview', 'recovery/source', 'navigation/receipt', 'tools/inspect', 'policy/inspect',
  'attention', 'list', 'models', 'usage', 'context/inspect', 'snapshot', 'history/page', 'history/runs',
  'history/run-preview', 'history/usage', 'run', 'operation', 'events', 'operation/calls',
  'operation/retrieval-trace', 'operation/retrieval-file',
]);
const threadStops = new Set([
  'computer/stop', 'research/cancel', 'context/cancel', 'child/cancel', 'child/wait/cancel', 'tree/cancel',
  'followup/registration/cancel', 'policy/cancel', 'input/cancel', 'run/cancel', 'operation/cancel',
]);

// Some GET routes consume login tokens, create sessions/keys or initialize
// services. Admit known read/observation routes, rather than trusting the verb.
const reads = new Set([
  '/live', '/health', '/api/version', '/api/system/info', '/api/config/settings', '/api/config/themes',
  '/api/terminal/processes', '/api/terminal/shells', '/api/model-text', '/api/harness/local-semantic',
  '/api/varin/scheduled-tasks/status', '/api/varin/tunnel/status', '/api/varin/relay/status',
  '/api/varin/extensions/v1/host-state', '/api/varin/extensions/v1/catalog',
  '/api/computers', '/api/computers/vms', '/api/harness/bots', '/api/push/visibility',
  '/api/external-agents/observe', '/api/threads/observe', '/api/interactive-ui/view/observe',
  '/api/varin/events', '/api/notifications/stream', '/api/documents/watch', '/api/language/events',
  '/api/tasks/events', '/api/tests/events', '/api/debug/events',
]);
const readPaths = [
  /^\/api\/terminal\/[^/]+$/,
  /^\/api\/model-text\/requests\/[^/]+$/,
  /^\/api\/harness\/bots\/[^/]+(?:\/(?:matters|activity|presence|memory-maintenance|sessions|work))?$/,
  /^\/api\/computers\/desktops\/[^/]+\/(?:control|stream|apps)$/,
  /^\/api\/harness\/managed-execution\/v1\/(?:identity|lifecycle)$/,
  /^\/api\/harness\/managed-execution\/v1\/(?:jobs|shell)\/[^/]+\/[^/]+(?:\/output)?$/,
  /^\/api\/harness\/managed-execution\/v1\/outputs\/[^/]+$/,
];
const controls = new Set([
  '/api/system/shutdown', '/api/terminal/force-kill', '/api/tasks/cancel', '/api/debug/stop', '/api/tests/cancel',
  '/api/language-support/cancel', '/api/harness/local-semantic/cancel', '/api/varin/tunnel/stop',
  '/api/external-agents/stop', '/api/external-agents/disconnect',
  '/api/external-agents/settings', '/api/external-agents/list', '/api/external-agents/children',
  '/api/external-agents/child-presentation', '/api/external-agents/read',
  '/api/varin/extensions/v1/host-state/wait',
]);
const controlPaths = [
  /^\/api\/model-text\/requests\/[^/]+\/cancel$/,
  /^\/api\/harness\/bots\/[^/]+\/memory-maintenance\/cancel$/,
  /^\/api\/computers\/desktops\/[^/]+\/(?:stop|cancel|release)$/,
  /^\/api\/harness\/managed-execution\/v1\/resources\/(?:observe|release)$/,
  /^\/api\/harness\/managed-execution\/v1\/jobs\/[^/]+\/[^/]+\/(?:kill|release)$/,
  /^\/api\/harness\/managed-execution\/v1\/shell\/[^/]+\/[^/]+\/kill$/,
  /^\/api\/harness\/managed-execution\/v1\/sources\/(?:scriptControl|processControl|cancelService|observe|releaseReceipt|cancel|release|inspectScope|releaseScope|inspectReadScope|closeReadScope|integrationReceipt|fileReceipt)$/,
  /^\/api\/(?:harness\/managed-execution\/v1\/)?documents\/(?:read|resource\/identity|recovery\/(?:list|read)|workspace-edit\/(?:read|list|recovery|discard)|agent-input\/release|surface-operation\/(?:read|complete)|dirty\/barrier\/ack)$/,
];

export const isAllowedWhileDraining = (method: string, pathname: string): boolean => {
  if (method === 'OPTIONS') return true;
  if (method === 'GET' || method === 'HEAD') {
    if (reads.has(pathname) || readPaths.some(pattern => pattern.test(pathname))) return true;
    if (pathname === '/' || pathname === '/robots.txt' || /^\/assets\/[^?]+$/.test(pathname)) return true;
  }
  // Observation transport eligibility is not drain admission. In particular,
  // services/lease prepares providers and acquires a new Surface lease. Keep
  // its already-open stream, but never admit a new lease while draining.
  if (method === 'POST') {
    // This mixed route owns the authenticated, parsed-body cleanup fence.
    if (pathname === '/api/harness/managed-execution/v1/sources/service') return true;
    if (controls.has(pathname) || controlPaths.some(pattern => pattern.test(pathname))) return true;
    if (pathname.startsWith('/api/threads/')) {
      const command = pathname.slice('/api/threads/'.length);
      return threadReads.has(command) || threadStops.has(command);
    }
  }
  // Closing a terminal is cleanup, not deletion of a durable user asset.
  return method === 'DELETE' && /^\/api\/terminal\/[^/]+$/.test(pathname);
};

export const createDrainingAdmission = (isDraining: () => boolean): RequestHandler => (request, response, next) => {
  if (!isDraining() || isAllowedWhileDraining(request.method, request.path)) { next(); return; }
  response.setHeader('Retry-After', '1');
  response.status(503).json({ code: 'host-draining', error: 'Host is draining; new work is not accepted', admission: 'not_started' });
};

/** Observation HTTP responses outlive their events. Retain them during owner
 * drain, then end only these observers before server.close. This is not an
 * executor stop and does not release original work or its storage leases. */
export const createHttpObservationDrain = (): { middleware: RequestHandler; close(): void } => {
  const responses = new Set<import('express').Response>();
  let closed = false;
  const middleware: RequestHandler = (request, response, next) => {
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (!isAllowedObservationRequest(method, request.path) && !(method === 'GET' && request.path === '/api/varin/realtime-proxy/sse')) { next(); return; }
    if (closed) { response.status(503).json({ code: 'host-draining' }); return; }
    responses.add(response);
    const remove = () => { responses.delete(response); };
    response.once('finish', remove); response.once('close', remove);
    next();
  };
  return { middleware, close: () => {
    closed = true;
    for (const response of responses) response.end();
    responses.clear();
  } };
};
