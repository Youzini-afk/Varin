/** Actual KernelClient operations and ToolBridge with only request delivery replaced by stdio.
 * Shared by the finite material integration fixtures; never included in the product Host. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createThreadsHttpAPI, type ThreadMaterialsAPI } from '@varin/application-client';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClient, KernelScopedClient, type KernelGrantHandle } from './kernel-client.js';
import { permissionService } from './permission-service.js';
import { ToolBridge } from './tool-bridge.js';
import type { AgentRuntimeStreamEvent } from '@varin/protocol';

export const writeMaterialFixtureFrame = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
export function createMaterialReviewFixture(verifyGrant: (params: Record<string, unknown>) => void,
  sourceRegistration?: ConstructorParameters<typeof AgentRuntimeClient>[6]) {
  const write = writeMaterialFixtureFrame;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const issued = new Set<KernelGrantHandle>();
  const events = new Set<(event: AgentRuntimeStreamEvent) => void>();
  const exits = new Set<(error: Error) => void>();
  const ready = new Set<() => void>();
  let sequence = 0, epoch = '', storageRoot = '';
  function request<T>(method: string, params: unknown, grant?: KernelGrantHandle): Promise<T> {
    const id = `material-review:${++sequence}`;
    const response = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject });
      write({ kind: 'fixture-request', id, method, params, ...(grant ? { grantId: grant.grantId } : {}) });
    });
    if (method === 'runtime.permission.open') {
      // The controlled user answers the exact pending original permission, once.
      const value = params as { operationId: string; permissionId: string };
      void response.then(() => permissionService(kernel).decide(value.operationId, value.permissionId, 'allow_once'))
        .catch(error => write({ kind: 'fixture-failed', error: String(error) }));
    }
    return response;
  }
  const transport = {
    get kernelEpoch() { return epoch; },
    get handshake() { return { storageRoot, hostId: 'web-domain-host' }; },
    subscribeReady(listener: () => void) { ready.add(listener); return () => { ready.delete(listener); }; },
    subscribeExit(listener: (error: Error) => void) { exits.add(listener); return () => { exits.delete(listener); }; },
    onAgentRuntimeEvent(listener: (event: AgentRuntimeStreamEvent) => void) { events.add(listener); return () => { events.delete(listener); }; },
    onToolReleased() { return () => {}; },
    toolCallbackEnded: (...args: Parameters<ToolBridge['callbackEnded']>) => bridge.callbackEnded(...args),
    publishRecoveredToolReceipt: (...args: Parameters<ToolBridge['publishRecoveredReceipt']>) => bridge.publishRecoveredReceipt(...args),
    cancelRunPreparation() {}, unregisterCredentialOwner() {}, releaseRunPolicyOwners() {},
    unregisterToolOwners(runId: string) { bridge.unregister(runId); },
    agentRuntimeRequest: (method: string, params: unknown) => request(method, params),
    requestRaw: (method: string, params: unknown, options: { grant?: KernelGrantHandle } = {}) => request(method, params, options.grant),
    assertGrant(grant: KernelGrantHandle) { assert(issued.has(grant)); assert.equal(grant.kernelEpoch, epoch); return grant; },
    assertGrantForScope(grant: KernelGrantHandle) { return this.assertGrant(grant); },
    scoped(grant: KernelGrantHandle) { return new KernelScopedClient(kernel, grant); },
    async issueGrant(params: Record<string, unknown>) {
      verifyGrant(params);
      const raw = await request<Record<string, unknown>>('authority.grant.issue', {
        sessionId: null, threadId: null, runId: null, owningWorkspace: null, executionWorkspace: null,
        storageIdentity: storageRoot, ...params, hostGeneration: 'web-domain-generation',
      });
      const grant: KernelGrantHandle = Object.freeze({ grantId: String(raw.grant_id), kernelEpoch: String(raw.kernel_epoch), hostGeneration: String(raw.host_generation),
        authorityInstanceId: null, workerId: null, workerGeneration: null, sessionId: null,
        threadId: raw.thread_id as string | null, runId: raw.run_id as string | null, operationId: raw.operation_id as string | null,
        owningWorkspace: raw.owning_workspace as string | null, executionWorkspace: raw.execution_workspace as string | null,
        capabilities: raw.capabilities as string[], pathScopes: raw.path_scopes as string[], storageIdentity: String(raw.storage_identity) });
      issued.add(grant); return grant;
    },
    revokeGrant: (grantId: string) => request('authority.grant.revoke', { grantId }),
    retireGrant: (grantId: string) => request('authority.grant.retire', { target: { kind: 'grant', grantId } }),
    retireOperationGrants: (operationId: string) => request('authority.grant.retire', { target: { kind: 'operation', operationId } }),
  };
  const kernel = transport as unknown as KernelClient;
  // Reuse original chunking and record/source methods, replacing only delivery.
  for (const name of ['gc', 'putBlob', 'getBlob', 'getOperation', 'releaseBlob', 'getRecord', 'listRecords', 'putRecord', 'releaseRecord',
    'readBranch', 'createBranch', 'deleteBranch', 'pinBranch', 'unpinBranch', 'fileRootRegister', 'fileReadCheck',
    'fileCapture', 'fileMaterialize', 'fileLeaseAcquire', 'fileLeaseRelease', 'experimentArtifacts'] as const) {
    const method = KernelClient.prototype[name];
    Object.defineProperty(transport, name, { value: (...args: unknown[]) => Reflect.apply(method, kernel, args) });
  }
  const runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, undefined, sourceRegistration);
  const bridge = new ToolBridge(() => epoch, async frame => { write(frame); }, () => write({ kind: 'fixture-failed', error: 'original tool bridge failed' }));
  return { kernel, runtime, bridge, request,
    initialize(frame: Record<string, unknown>) { epoch = String(frame.epoch); storageRoot = String(frame.storageRoot); for (const listener of ready) listener(); },
    receive(frame: Record<string, unknown>) {
      if (frame.kind === 'runtime-event') { for (const listener of events) listener(frame as AgentRuntimeStreamEvent); return true; }
      if (frame.kind === 'fixture-kernel-exit') { for (const listener of exits) listener(new Error('Controlled original kernel exit')); return true; }
      if (frame.kind === 'fixture-response') {
        const waiting = pending.get(String(frame.id)); assert(waiting); pending.delete(String(frame.id));
        if (frame.ok) waiting.resolve(frame.result); else waiting.reject(new Error(String(frame.error)));
        return true;
      }
      return bridge.consume(frame);
    },
  };
}

/** Actual public client/authentication/route chain, with in-memory delivery only. */
export async function withMaterialReviewClient<T>(runtime: AgentRuntimeClient, materials: ThreadMaterialsAPI,
  consume: (api: ReturnType<typeof createThreadsHttpAPI>) => Promise<T>): Promise<T> {
  const unexpected = async (): Promise<never> => { throw new Error('Material reading attempted model or file-source work'); };
  const adapter = new ThreadAdapter(runtime, { resolveModel: unexpected, rebindModel: unexpected }, unexpected, unexpected);
  const routes = new Map<string, RequestHandler[]>();
  const app = { post(path: string, ...handlers: RequestHandler[]) { routes.set(path, handlers); }, get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'fixture-material-user') { response.status(401).end(); return; } next();
  }, undefined, undefined, materials);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const handlers = routes.get(new URL(String(input), 'https://application.invalid').pathname); assert(handlers);
    let status = 200, output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; }, json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; }, setHeader() { return this; } });
    const request = Object.assign(new EventEmitter(), { body: JSON.parse(String(init?.body)), headers: { authorization: 'fixture-material-user' } });
    await new Promise<void>((resolve, reject) => {
      let index = 0; const next = (error?: unknown) => {
        if (error) { reject(error); return; } const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request as Request, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  }) as typeof globalThis.fetch;
  try { return await consume(createThreadsHttpAPI()); }
  finally { globalThis.fetch = originalFetch; }
}
