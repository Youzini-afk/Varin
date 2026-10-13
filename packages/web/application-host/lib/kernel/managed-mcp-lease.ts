/** Coordinator projection of one target-owned MCP view; all dispatch stays on that view. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { McpAuthorityError, type McpAuthorityLease, type McpAuthorityTool, type McpAuthorityService,
  type McpAuthorityPrompt, type McpServiceRequest } from '@varin/pi-host/mcp-authority';
import { compileToolJsonSchema } from '@varin/pi-host/tool-schema';
import type { ManagedSourceAccess } from './managed-source-consumers.js';
import { createManagedMcpTaskLease } from './managed-mcp-task-lease.js';
import type { McpBinding, McpEndpoint, SourceResourceOwner } from './protocol.generated.js';
import type { ManagedMcpAction, ManagedMcpSnapshot, ManagedMcpRevocations } from '../harness/managed-mcp-contract.js';
import { isManagedMcpRevocations } from '../harness/managed-mcp-contract.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string): never => { throw new McpAuthorityError(code); };
export async function createManagedMcpLease(input: {
  access: ManagedSourceAccess;
  coordinatorHostId: string;
  owner: SourceResourceOwner;
  selection?: McpBinding;
  lifetime: AbortSignal;
  observeRevocations(handleId: string, receive: (facts: ManagedMcpRevocations) => void): () => void;
  signal?: AbortSignal;
}): Promise<{ lease: McpAuthorityLease; snapshot: ManagedMcpSnapshot }> {
  const { access } = input;
  const handleId = `mcp-view:${randomUUID()}`;
  const creationRequestId = `mcp-prepare:${randomUUID()}`;
  let released = false;
  const localLifetime = new AbortController();
  const toolRevocations = new Map<string, AbortController>(), serviceRevocations = new Map<string, AbortController>();
  const receiveRevocations = (facts: ManagedMcpRevocations) => {
    for (const [entries, field] of [[toolRevocations, 'tools'], [serviceRevocations, 'services']] as const) {
      for (const target of facts[field]) {
        const name = 'name' in target ? target.name : target.server;
        const key = JSON.stringify([name, target.schemaVersion]);
        let token = entries.get(key); if (!token) { token = new AbortController(); entries.set(key, token); } token.abort();
      }
    }
  };
  const call = async <T>(action: ManagedMcpAction, signal?: AbortSignal): Promise<T> => {
    if (action.kind !== 'release') {
      if (released) fail('mcp_lease_released');
      input.lifetime.throwIfAborted(); signal?.throwIfAborted();
    }
    const reply = await access.client.service({ coordinatorHostId: input.coordinatorHostId,
      authorityId: access.binding.authorityId, resourceEpoch: access.binding.resourceEpoch,
      requestId: action.kind === 'snapshot' ? creationRequestId : `mcp-request:${randomUUID()}`, operation: { kind: 'mcp', action } }, action.kind === 'release' ? signal : AbortSignal.any([input.lifetime, ...(signal ? [signal] : [])]));
    if (!reply.ok) throw new McpAuthorityError(reply.error.code, reply.error.dispatched, reply.error.settlement,
      reply.error.protocolError, reply.error.interactionProblem);
    return reply.value as T;
  };
  let snapshot: ManagedMcpSnapshot;
  try {
    snapshot = await call<ManagedMcpSnapshot>({ kind: 'snapshot', handleId, creationRequestId,
      ...(input.selection ? { selection: input.selection } : {}) }, input.signal);
    if (!record(snapshot) || typeof snapshot.incarnation !== 'string' || !snapshot.incarnation
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !record(snapshot.binding)
      || !record(snapshot.binding.provenance) || !record(snapshot.binding.provenance.servers)
      || !Array.isArray(snapshot.binding.tools) || !Array.isArray(snapshot.binding.servers)
      || !record(snapshot.binding.readiness) || !Array.isArray(snapshot.binding.serverSelections)
      || typeof snapshot.implementationIdentity !== 'string' || !isManagedMcpRevocations(snapshot.revocations)) fail('mcp_source_binding_invalid');
    for (const server of Object.values(snapshot.binding.provenance.servers)) {
      if (!record(server) || !record(server.owner) || !isDeepStrictEqual(server.owner.resource_owner, input.owner)
        || server.owner.execution_scope !== 'workspace' || !isDeepStrictEqual(server.owner.source_authority, {
          coordinator_host_id: input.coordinatorHostId, authority_id: access.binding.authorityId, resource_epoch: access.binding.resourceEpoch })) fail('mcp_source_owner_changed');
    }
    for (const tool of snapshot.binding.tools) {
      if (!record(tool) || typeof tool.name !== 'string' || typeof tool.server !== 'string' || typeof tool.schemaVersion !== 'string'
        || tool.resourceKey !== snapshot.binding.provenance.servers[tool.server]?.resource_key) fail('mcp_source_tool_changed');
    }
    input.signal?.throwIfAborted(); input.lifetime.throwIfAborted();
  } catch (error) {
    // A lost snapshot reply may still own a real target view. Exact release never re-prepares it.
    void call({ kind: 'release', handleId, creationRequestId }).catch(() => undefined);
    throw error;
  }
  receiveRevocations(snapshot.revocations);
  const unobserve = input.observeRevocations(handleId, receiveRevocations);
  const revokedSignal = (entries: Map<string, AbortController>, name: string, version: string) => {
    const key = JSON.stringify([name, version]); let token = entries.get(key);
    if (!token) { token = new AbortController(); entries.set(key, token); }
    return AbortSignal.any([input.lifetime, localLifetime.signal, token.signal]);
  };
  const validators = new Map<string, ReturnType<typeof compileToolJsonSchema>>();
  const tools = new Map<string, McpAuthorityTool>();
  const services = new Map<string, McpAuthorityService>();
  const key = (name: string, version: string) => JSON.stringify([name, version]);
  const assertLive = () => { if (released || input.lifetime.aborted) fail('mcp_source_view_unavailable'); };
  const admitTools = (values: readonly McpAuthorityTool[]) => {
    for (const tool of values) {
      if (tool.resourceKey !== snapshot.binding.provenance.servers[tool.server]?.resource_key) fail('mcp_source_tool_changed');
      tools.set(key(tool.name, tool.schemaVersion), tool);
    }
    return values;
  };
  const admitService = (service: McpAuthorityService) => {
    if (service.resourceKey !== snapshot.binding.provenance.servers[service.server]?.resource_key) fail('mcp_source_service_changed');
    services.set(key(service.server, service.schemaVersion), service); return service;
  };
  admitTools(snapshot.binding.tools);
  const assertCallable = (name: string, version: string) => {
    assertLive(); if (revokedSignal(toolRevocations, name, version).aborted) fail('mcp_tool_revoked'); const tool = tools.get(key(name, version)); if (!tool) fail('mcp_target_unbound'); return tool!;
  };
  const validateArguments = (name: string, version: string, args: unknown) => {
    const tool = assertCallable(name, version), identity = key(name, version);
    let validate = validators.get(identity);
    if (!validate) { validate = compileToolJsonSchema(tool.inputSchema); validators.set(identity, validate); }
    if (!validate(args)) fail('mcp_arguments_invalid');
  };
  const assertService = (service: McpAuthorityService) => {
    assertLive(); if (revokedSignal(serviceRevocations, service.server, service.schemaVersion).aborted) fail('mcp_service_revoked');
    if (!isDeepStrictEqual(services.get(key(service.server, service.schemaVersion)), service)) fail('mcp_service_unbound');
  };
  const validateServiceRequest = (service: McpAuthorityService, request: McpServiceRequest) => {
    assertService(service);
    if (!request.operation.startsWith(`${service.kind}/`)) fail('mcp_service_operation_invalid');
  };
  const lease: McpAuthorityLease = {
    binding: snapshot.binding, implementationIdentity: `${snapshot.incarnation}:${snapshot.implementationIdentity}`,
    inspect: () => { assertLive(); return snapshot.binding.readiness; },
    discover: async (server, signal) => admitTools(await call({ kind: 'discover', handleId, server }, signal)),
    prepareTool: async (server, tool, schemaVersion, signal) => {
      const selected = await call<McpAuthorityTool>({ kind: 'prepare_tool', handleId, server, tool, schemaVersion }, signal);
      admitTools([selected]); return selected;
    },
    discoverServices: async (server, signal) => (await call<McpAuthorityService[]>({ kind: 'discover_services', handleId, server }, signal)).map(admitService),
    prepareService: async (server, serviceKind, schemaVersion, signal) => admitService(await call({ kind: 'prepare_service', handleId, server, serviceKind, schemaVersion }, signal)),
    preparePrompt: async (server, name, schemaVersion, signal) => {
      const prompt = await call<McpAuthorityPrompt>({ kind: 'prepare_prompt', handleId, server, name, schemaVersion }, signal);
      admitService(prompt.service); return prompt;
    },
    assertCallable, validateArguments, assertService, validateServiceRequest,
    revocationSignal: (name, version) => { assertCallable(name, version); return revokedSignal(toolRevocations, name, version); },
    serviceRevocationSignal: service => { assertService(service); return revokedSignal(serviceRevocations, service.server, service.schemaVersion); },
    async callTool(name, arguments_, options) {
      validateArguments(name, options.schemaVersion, arguments_); await options.beforeDispatch?.();
      assertCallable(name, options.schemaVersion); options.signal.throwIfAborted();
      try { return await call({ kind: 'call', handleId, name, schemaVersion: options.schemaVersion, arguments: arguments_ },
        AbortSignal.any([options.signal, revokedSignal(toolRevocations, name, options.schemaVersion)])); }
      catch (error) { if (error instanceof McpAuthorityError) throw error; throw new McpAuthorityError('mcp_source_response_lost', true); }
    },
    async requestService(service, request, options) {
      validateServiceRequest(service, request); await options.beforeDispatch?.(); assertService(service); options.signal.throwIfAborted();
      try { return await call({ kind: 'service', handleId, service, request },
        AbortSignal.any([options.signal, revokedSignal(serviceRevocations, service.server, service.schemaVersion)])); }
      catch (error) { if (error instanceof McpAuthorityError) throw error; throw new McpAuthorityError('mcp_source_response_lost', true); }
    },
    async taskOwner(server, endpoint, signal, origin) {
      if (!origin) return fail('mcp_task_original_identity_missing');
      const selected = await call<McpEndpoint>({ kind: 'task_prepare', handleId, server, ...(endpoint ? { endpoint } : {}) }, signal);
      if (!record(selected) || selected.server !== server || selected.resourceKey !== snapshot.binding.provenance.servers[server]?.resource_key
        || typeof selected.configurationVersion !== 'string' || typeof selected.credentialVersion !== 'string'
        || endpoint && !isDeepStrictEqual(endpoint, selected)) return fail('mcp_task_original_endpoint_changed');
      return createManagedMcpTaskLease({ client: access.client, address: { coordinatorHostId: input.coordinatorHostId,
        authorityId: access.binding.authorityId, resourceEpoch: access.binding.resourceEpoch },
        binding: { ...origin, purpose: 'task', endpoint: selected }, creation: { handleId, lifetime: input.lifetime } });
    },
    resourceEndpoint: () => fail('mcp_managed_observer_owner_unavailable'),
    observeResource: async () => fail('mcp_managed_observer_owner_unavailable'),
    release() {
      if (released) return; released = true; unobserve(); localLifetime.abort();
      void call({ kind: 'release', handleId, creationRequestId }).catch(() => undefined);
    },
  };
  return { lease, snapshot };
}
