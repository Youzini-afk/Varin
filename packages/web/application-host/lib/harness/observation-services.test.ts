import { describe, expect, it } from "vitest";
import { sliceUtf8ByBytes, type DiagnosticItem, type HarnessActorContext } from "@varin/protocol";
import { createLspDiagnosticsSnapshotService, type DiagnosticsProvider } from "./diagnostics-service.js";
import { createContextRetainedService, createShellExecService, createShellKillService, createShellReadService, createShellWriteService } from "./harness-services.js";
import { createObservationCursorStore } from "./observation-cursors.js";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";

const ACTOR: HarnessActorContext = {
  authorityInstanceId: "authority",
  sessionId: "observer",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace",
  grantedCapabilities: ["context.session", "process.shell", "read.lsp"],
};

const context = (canonicalResourceId = "src/main.ts"): HarnessServiceContext => ({
  actor: ACTOR,
  authorizedPaths: [{
    authorityId: "authority",
    workspaceId: "workspace",
    canonicalResourceId,
    inputPath: canonicalResourceId,
    resourceId: canonicalResourceId,
  }],
  sessionId: ACTOR.sessionId,
  workspaceId: ACTOR.workspaceId,
  signal: new AbortController().signal,
});

describe("incremental shell observation", () => {
  it("keeps local shell handles usable in a no-project session when remote routing is installed", async () => {
    const remoteScopes: string[] = [];
    const host = {
      managedRemoteTargets: {
        shellRead: async (scope: string) => { remoteScopes.push(scope); return null; },
        shellWrite: async (scope: string) => { remoteScopes.push(scope); return null; },
        shellKill: async (scope: string) => { remoteScopes.push(scope); return null; },
      },
      getShellSupervisor: () => ({
        read: async () => ({ ...sliceUtf8ByBytes("done", 0, 4), running: false, exitCode: 0 }),
        write: async () => true,
        kill: async () => true,
      }),
    } as unknown as HarnessServiceHost;
    const noProject = { ...context(), actor: { ...ACTOR, workspaceId: null }, workspaceId: null };
    expect(await createShellReadService(host).handle({ id: "sh_local", offset: 0 }, noProject)).toMatchObject({ text: "done" });
    expect(await createShellWriteService(host).handle({ id: "sh_local", text: "input" }, noProject)).toEqual({ accepted: true });
    expect(await createShellKillService(host).handle({ id: "sh_local" }, noProject)).toEqual({ killed: true });
    expect(remoteScopes).toEqual(["session:observer", "session:observer", "session:observer"]);
  });

  it("starts after the output already returned by a backgrounded bash call", async () => {
    let output = "already shown";
    const cursors = createObservationCursorStore();
    const supervisor = {
      exec: async () => ({ kind: "background" as const, id: "sh_1", waitedMs: 10, cwd: ".", outputSoFar: "already shown" }),
      read: async (_id: string, offset = 0, length = 32_768) => ({
        ...sliceUtf8ByBytes(output, offset, length),
        running: true,
      }),
    };
    const host = {
      observationCursors: cursors,
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    await createShellExecService(host).handle({ command: "slow", waitMs: 10 }, context());
    output += " new";
    const observed = await createShellReadService(host).handle({ id: "sh_1" }, context());
    expect(observed).toMatchObject({ text: " new", offset: 13, observation: { first: false } });
    cursors.dispose();
  });

  it("advances only default reads and resets the baseline after compaction", async () => {
    let now = 1_000;
    let output = "first";
    const shellState: { exitCode?: number; running: boolean } = { running: true };
    const cursors = createObservationCursorStore({ now: () => now });
    const supervisor = {
      read: async (_id: string, offset = 0, length = 32_768) => ({
        ...sliceUtf8ByBytes(output, offset, length),
        running: shellState.running,
        ...(shellState.exitCode === undefined ? {} : { exitCode: shellState.exitCode }),
        lastOutputAt: 900,
      }),
    };
    let retainedThreadCursors = 0;
    const host = {
      observationCursors: cursors,
      getShellSupervisor: () => supervisor,
      threadRegistry: { retainCursorsForSession: () => { retainedThreadCursors += 1; } },
    } as unknown as HarnessServiceHost;
    const service = createShellReadService(host);

    const first = await service.handle({ id: "sh_1" }, context());
    expect(first).toMatchObject({ text: "first", offset: 0, nextOffset: 5, observation: { first: true } });

    output += "你";
    now = 2_000;
    const second = await service.handle({ id: "sh_1" }, context());
    expect(second).toMatchObject({ text: "你", offset: 5, length: 3, nextOffset: 8, observation: { first: false, sinceMs: 1_000 } });

    const randomAccess = await service.handle({ id: "sh_1", offset: 0, length: 5 }, context());
    expect(randomAccess.text).toBe("first");
    expect(randomAccess.observation).toBeUndefined();

    output += " done";
    shellState.running = false;
    shellState.exitCode = 0;
    now = 3_000;
    const final = await service.handle({ id: "sh_1" }, context());
    expect(final).toMatchObject({ text: " done", running: false, exitCode: 0, observation: { first: false } });
    const unchanged = await service.handle({ id: "sh_1" }, context());
    expect(unchanged).toMatchObject({ text: "", length: 0, running: false, exitCode: 0 });

    await createContextRetainedService(host).handle({ retainedObservationRefs: [], retainedGit: false }, context());
    expect(retainedThreadCursors).toBe(1);
    const afterCompaction = await service.handle({ id: "sh_1" }, context());
    expect(afterCompaction).toMatchObject({ text: output, offset: 0, observation: { first: true } });
    cursors.dispose();
  });

  it("waits from the committed byte cursor while explicit history remains immediate", async () => {
    let output = "first";
    let releaseWait: (() => void) | undefined;
    const waits: Array<{ id: string; offset: number; waitMs: number; signal: AbortSignal }> = [];
    const cursors = createObservationCursorStore();
    const supervisor = {
      read: async (_id: string, offset = 0, length = 32_768) => ({
        ...sliceUtf8ByBytes(output, offset, length),
        running: true,
      }),
      waitForOutput: async (id: string, offset: number, waitMs: number, signal: AbortSignal) => {
        waits.push({ id, offset, waitMs, signal });
        await new Promise<void>((resolve, reject) => {
          releaseWait = resolve;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const host = {
      observationCursors: cursors,
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    const service = createShellReadService(host);
    await service.handle({ id: "sh_1" }, context());

    const pending = service.handle({ id: "sh_1", waitMs: 5_000 }, context());
    await Promise.resolve();
    expect(waits).toMatchObject([{ id: "sh_1", offset: 5, waitMs: 5_000 }]);
    output += " next";
    releaseWait?.();
    await expect(pending).resolves.toMatchObject({ text: " next", offset: 5, running: true });

    const historical = await service.handle({ id: "sh_1", offset: 0, length: 5, waitMs: 5_000 }, context());
    expect(historical.text).toBe("first");
    expect(waits).toHaveLength(1);
    cursors.dispose();
  });
});

describe("incremental diagnostics observation", () => {
  it("returns added and resolved diagnostics while full reads leave the cursor alone", async () => {
    const a: DiagnosticItem = { line: 1, character: 1, severity: "error", code: "A", message: "first", source: "ts" };
    const b: DiagnosticItem = { line: 2, character: 1, severity: "warning", code: "B", message: "second", source: "ts" };
    let diagnostics = [a];
    const provider: DiagnosticsProvider = {
      getDiagnosticsForRevision: async () => diagnostics,
      bindDocument: async () => ({ status: "bound", revision: "r1", source: "disk" }),
      getSnapshot: async () => "1",
    };
    const cursors = createObservationCursorStore();
    const service = createLspDiagnosticsSnapshotService(provider, cursors);

    const first = await service.handle({ path: "src/main.ts" }, context());
    expect(first).toMatchObject({ diagnostics: [a], resolvedDiagnostics: [], observation: { first: true, added: 1, resolved: 0 } });

    diagnostics = [a, b];
    const full = await service.handle({ path: "src/main.ts", full: true }, context());
    expect(full.diagnostics).toEqual([a, b]);
    expect(full.observation).toBeUndefined();

    const added = await service.handle({ path: "src/main.ts" }, context());
    expect(added).toMatchObject({ diagnostics: [b], resolvedDiagnostics: [], observation: { first: false, added: 1, resolved: 0 } });

    diagnostics = [b];
    const resolved = await service.handle({ path: "src/main.ts" }, context());
    expect(resolved).toMatchObject({ diagnostics: [], resolvedDiagnostics: [a], observation: { first: false, added: 0, resolved: 1 } });

    const unchanged = await service.handle({ path: "src/main.ts" }, context());
    expect(unchanged).toMatchObject({ diagnostics: [], resolvedDiagnostics: [], observation: { added: 0, resolved: 0 } });
    cursors.dispose();
  });
});
