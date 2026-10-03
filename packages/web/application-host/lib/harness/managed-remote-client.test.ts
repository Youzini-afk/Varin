import { describe, expect, it, vi } from "vitest";
import { createManagedRemoteTargetRegistry } from "./managed-remote-client.js";

describe("managed remote target recovery", () => {
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
    const caller = {
      workspaceId: "workspace-a",
      executionWorkspaceId: "workspace-a",
      sessionId: "session-a",
      rootSessionId: "session-a",
      allowedThreadIds: [],
    };

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
