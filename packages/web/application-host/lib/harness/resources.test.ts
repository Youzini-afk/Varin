import { describe, expect, it, vi } from 'vitest';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { registerManagedRemoteRoutes } from './managed-remote-routes.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { createResourceService } from './resources.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import { createManagedRemoteTargetRegistry } from './managed-remote-client.js';

// Real resource/remote owners; only durable Storage and HTTP transport are fixtures.
function storage() {
  const records = new Map<string, KernelRecordResult>();
  let failReceipt = false;
  const scoped = {
    async getRecord(workspace: string, id: string) { return structuredClone(records.get(`${workspace}\0${id}`) ?? null); },
    async putRecord(input: Record<string, unknown>) {
      if (failReceipt && input.recordType === 'managed.remote.admission') { failReceipt = false; throw new Error('receipt write reply lost'); }
      const key = `${input.workspaceId}\0${input.recordId}`;
      const old = records.get(key);
      if (old ? input.expectedRecordRevision !== old.recordRevision : input.expectedRecordRevision !== undefined) throw new Error('record revision conflict');
      const value = { ...input, recordRevision: (old?.recordRevision ?? 0) + 1, createdAt: old?.createdAt ?? 1, updatedAt: 1 } as unknown as KernelRecordResult;
      records.set(key, structuredClone(value)); return structuredClone(value);
    },
    async listRecords(input: { workspaceId: string; recordType: string }) {
      return { records: structuredClone([...records.values()].filter(v => v.workspaceId === input.workspaceId && v.recordType === input.recordType)), nextCursor: null };
    },
  };
  return { records, loseReceipt: () => { failReceipt = true; }, client: {
    start: async () => ({}), issueGrant: async () => ({}), scoped: () => scoped,
  } as unknown as KernelClient };
}
const probes = {
  probeLocal: () => ({ cpuCores: 4, memoryMb: 1024, usedMemoryMb: 0 }),
  probeLocalGpu: async () => ({ status: 'unavailable' as const, reason: 'no-device' as const }),
};

describe('original resource admission reconciliation', () => {
  it.each(['remote-reply', 'target-receipt'] as const)('recovers a lost %s through the original target owner without allocating again', async loss => {
    const targetStorage = storage();
    const targetResources = createResourceService({ client: targetStorage.client, ...probes });
    const targetAdmit = vi.spyOn(targetResources, 'admit');
    const target = createManagedRemoteExecutionService({ client: targetStorage.client, hostId: 'target', resources: targetResources });
    const coordinatorStorage = storage();
    const coordinator = createResourceService({ client: coordinatorStorage.client, ...probes,
      resolveExternalAuthority: (machine, record) => registry.externalAuthority(machine, record) });
    const routes = new Map<string, RequestHandler[]>();
    const common: RequestHandler[] = [];
    const app = { use: (_path: string, handler: RequestHandler) => { common.push(handler); },
      get: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers),
      post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers),
      put: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers),
    } as unknown as Express;
    registerManagedRemoteRoutes(app, { service: target, resolveAuthContext: async () => ({ type: 'client', clientId: 'principal',
      client: { capabilities: ['filesystem:read', 'filesystem:write', 'logs:read', 'terminal:use', 'process:control'] } as never }) });
    const fetched: string[] = [];
    let loseReply = loss === 'remote-reply';
    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const route = String(url).split('/v1')[1]!; fetched.push(route);
      const input = init?.body ? JSON.parse(String(init.body)) : undefined;
      let value: unknown; let status = 200;
      const headers = new Headers();
      const response = { writableEnded: false, destroyed: false,
        setHeader(name: string, header: string) { headers.set(name, header); },
        status(code: number) { status = code; return this; },
        json(body: unknown) { value = body; this.writableEnded = true; return this; },
      };
      const request = { body: input } as Request;
      const handlers = [...common, ...(routes.get(`/api/harness/managed-execution/v1${route}`) ?? [])];
      await new Promise<void>((resolve, reject) => {
        let index = 0;
        const next = (error?: unknown) => {
          if (error) { reject(error); return; }
          const handler = handlers[index++];
          if (!handler) { reject(new Error(`unhandled target route: ${route}`)); return; }
          Promise.resolve(handler(request, response as unknown as ExpressResponse, next))
            .then(() => { if (response.writableEnded) resolve(); }, reject);
        };
        next();
      });
      if (route === '/resources/admit' && loseReply) { loseReply = false; throw new Error('remote admission reply lost'); }
      return new Response(JSON.stringify(value), { status, headers });
    };
    const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: coordinatorStorage.client,
      resources: coordinator, readSettings: async () => ({ desktopHosts: [{ id: 'target-connection', apiUrl: 'https://target.example' }] }),
      fetch: fetchMock as typeof fetch });
    await registry.refresh('workspace');
    expect(await coordinator.reconcileAdmission('workspace', 'managed:target', { cpuCores: 1 }, 'attempt')).toEqual({ status: 'unknown' });
    if (loss === 'target-receipt') targetStorage.loseReceipt();
    await expect(coordinator.admit('workspace', 'managed:target', { cpuCores: 1 }, 'attempt')).rejects.toThrow(/lost/);
    expect(targetAdmit).toHaveBeenCalledTimes(1);
    const recovered = await coordinator.reconcileAdmission('workspace', 'managed:target', { cpuCores: 1 }, 'attempt');
    expect(recovered.status).toBe('confirmed');
    expect(targetAdmit).toHaveBeenCalledTimes(1);
    expect(fetched.filter(route => route === '/resources/admit')).toHaveLength(1);
    await expect(coordinator.reconcileAdmission('workspace', 'managed:target', { cpuCores: 2 }, 'attempt')).rejects.toThrow(/identity conflict/);
    expect(await target.observeAdmission({ coordinatorHostId: 'coordinator', workspaceId: 'workspace', machineId: 'managed:target', attemptId: 'attempt', resources: { cpuCores: 1 } }, 'other-principal')).toEqual({ status: 'unknown' });
    if (recovered.status !== 'confirmed') throw new Error('original reservation was not recovered');
    await coordinator.release('workspace', recovered.commitmentId, 'cancelled after original receipt recovery');
    expect(await coordinator.reconcileAdmission('workspace', 'managed:target', { cpuCores: 1 }, 'attempt')).toEqual({ status: 'not-admitted' });
    expect([...targetStorage.records.values()].filter(v => v.recordType === 'resource.commitment' && v.state === 'confirmed')).toHaveLength(0);
    expect([...targetStorage.records.values()].filter(v => v.recordType === 'managed.remote.admission')).toMatchObject([{ state: 'released' }]);
  });
});
