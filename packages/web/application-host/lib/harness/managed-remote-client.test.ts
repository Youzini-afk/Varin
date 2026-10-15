import { nativeResearchCaller } from './native-research.fixture.js';
import { describe, expect, it, vi } from "vitest";
import { createManagedRemoteTargetRegistry } from "./managed-remote-client.js";
import { ExperimentPreparationError } from "./experiment-backend.js";
import type { ExperimentInputSnapshot } from "./experiment-workspace.js";

describe("managed remote target recovery", () => {
  it('retains a dispatched materialization through cancellation and reconciles only its original ready receipt', async () => {
    let ready = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'x-varin-managed-host': 'remote-host' } });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/identity')) return reply({ protocolVersion: 1, hostId: 'remote-host',
        capabilities: ['managed-execution'], machine: { machineId: 'managed:remote-host', kind: 'managed-remote', state: 'available' } });
      if (String(url).endsWith('/materials/probe')) return reply({ ready, missingObjects: [],
        ...(ready ? { rootId: 'root', canonicalRoot: '/original/material' } : {}) });
      expect(String(url)).toContain('/materials/commit');
      expect(init?.signal).toBeUndefined();
      enter(); await held; ready = true;
      return reply({ materialId: 'original-root', root: 'original-root', rootId: 'root', canonicalRoot: '/original/material', cwd: '', reused: false });
    });
    const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'host',
      kernel: { start: async () => ({}), issueGrant: async (grant: object) => grant, retireGrant: async () => ({}),
        scoped: () => ({ readBranch: async () => ({ workspaceId: 'workspace', root: 'original-root', currentRoot: 'original-root', entries: [], nextCursor: null }) }) } as never,
      resources: { listMachines: async () => [], registerMachine: async () => ({}) } as never,
      readSettings: async () => ({ desktopHosts: [{ id: 'remote', apiUrl: 'https://remote.example' }] }), fetch: fetchMock as typeof fetch,
    });
    const input: ExperimentInputSnapshot = { schemaVersion: 2, source: {kind:"physical-capture"}, branchId: 'input', root: 'original-root', sourceRoot: '/source',
      workspaceId: 'workspace', executionWorkspaceId: 'workspace', captureScopes: [], capturedPathCount: 0, inventoryFingerprint: 'inventory',
      captureSemantics: { excludedDirectories: ['.git', '.varin'], gitignore: 'not-applied', ignoredFilesIncluded: true } };
    const resolved = await registry.resolveBackend({} as never, 'managed:remote-host',
      { payloadJson: JSON.stringify({ backend: 'managed-remote' }) } as never,
      nativeResearchCaller({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', readThreadIds: [] }));
    expect(resolved).not.toBeNull();
    expect(await resolved!.reconcilePreparation!({ attemptId: 'attempt', input })).toBe('unknown');
    const controller = new AbortController(); let settled = false;
    const pending = resolved!.prepare({ attemptId: 'attempt', input, signal: controller.signal }).finally(() => { settled = true; });
    await entered; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release(); expect((await pending).inputRoot).toBe('original-root');
    expect(await resolved!.reconcilePreparation!({ attemptId: 'attempt', input })).toBe('drained');
    await expect(resolved!.prepare({ attemptId: 'not-dispatched', input, signal: controller.signal }))
      .rejects.toMatchObject({ name: ExperimentPreparationError.name, drained: true });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/materials/commit'))).toHaveLength(1);
  });
  it('releases only the removed owner receipts while retaining shared machine ownership', async () => {
    const targets = new Set(['bot:a', 'bot:b']);
    const releaseRecord = vi.fn(async (_operation: string, workspaceId: string, recordId: string) => {
      expect(recordId).toBe('managed.shell.target:managed:vm'); targets.delete(workspaceId);
    });
    const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'host',
      kernel: {
        issueGrant: async (grant: object) => grant, revokeGrant: async () => {},
        recordWorkspaces: async () => ({ workspaceIds: [...targets] }),
        scoped: () => ({ releaseRecord, listRecords: async ({ workspaceId, recordType }: { workspaceId: string; recordType: string }) => ({
          records: targets.has(workspaceId) && recordType === 'managed.shell.target'
            ? [{ recordId: 'managed.shell.target:managed:vm', state: 'used', payloadJson: JSON.stringify({ machineId: 'managed:vm' }) }] : [], nextCursor: null,
        }) }),
      } as never,
      resources: {} as never, readSettings: async () => ({}),
    });
    await registry.releaseScope('bot:a');
    expect(await registry.ownersForMachine('managed:vm')).toEqual(['bot:b']);
    await registry.releaseScope('bot:a');
    expect(releaseRecord).toHaveBeenCalledTimes(1);
  });

  it("remembers a workspace binding before the first successful target probe", async () => {
    let reachable = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("/identity");
      if (!reachable) throw new Error("target offline");
      return new Response(JSON.stringify({
        protocolVersion: 1,
        hostId: "remote-host",
        capabilities: ["managed-execution"],
        machine: { machineId: "managed:remote-host", kind: "managed-remote", state: "available" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-varin-managed-host": "remote-host" },
      });
    });
    const reconciled: Array<{ workspaceId: string; machineId: string }> = [];
    const registry = createManagedRemoteTargetRegistry({
      coordinatorHostId: "coordinator",
      kernel: {} as never,
      resources: {
        listMachines: async () => [],
        registerMachine: async () => ({}),
      } as never,
      readSettings: async () => ({
        desktopHosts: [{ id: "remote", apiUrl: "https://remote.example", label: "Remote" }],
      }),
      fetch: fetchMock as typeof fetch,
      onTargetReachable: (workspaceId, machineId) => reconciled.push({ workspaceId, machineId }),
    });
    const machine = {
      payloadJson: JSON.stringify({ backend: "managed-remote" }),
    } as never;
    const caller = nativeResearchCaller({
      workspaceId: "workspace-a",
      executionWorkspaceId: "workspace-a",
      rootThreadId: "session-a",
      readThreadIds: [],
    });

    await expect(registry.resolveBackend({} as never, "managed:remote-host", machine, caller)).resolves.toBeNull();
    reachable = true;
    await registry.refresh("workspace-a");

    expect(reconciled).toEqual([{ workspaceId: "workspace-a", machineId: "managed:remote-host" }]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/jobs/submit"))).toBe(false);
  });

  it("passes an actor cancellation into the remote shell HTTP request", async () => {
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/identity")) {
        return new Response(JSON.stringify({
          protocolVersion: 1,
          hostId: "remote-host",
          capabilities: ["managed-execution"],
          machine: { machineId: "managed:remote-host", kind: "managed-remote", state: "available" },
        }), { status: 200, headers: { "x-varin-managed-host": "remote-host" } });
      }
      expect(url).toContain("/shell/exec");
      entered();
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("remote request has no cancellation signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const registry = createManagedRemoteTargetRegistry({
      coordinatorHostId: "coordinator",
      kernel: {} as never,
      resources: { listMachines: async () => [], registerMachine: async () => ({}) } as never,
      readSettings: async () => ({ desktopHosts: [{ id: "remote", apiUrl: "https://remote.example" }] }),
      fetch: fetchMock as typeof fetch,
    });
    await registry.refresh("workspace-a");
    const controller = new AbortController();
    const pending = registry.shellExec("workspace-a", "managed:remote-host", {
      toolCallId: "call-1", command: "echo test", waitMs: 60_000,
    }, controller.signal);
    await requestEntered;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
  });
});
