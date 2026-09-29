import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComputerService } from "./computer-service.js";
import type { DriverResponse, DriverSpawnSpec, ComputerDriverSession } from "./driver-host.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";

/**
 * BC4 focused coverage: catalog records, observation freshness, serialized
 * action/cancel semantics, and the persisted default target. Drivers are
 * faked; platform proof is the real-driver smoke test, not this suite.
 */

interface StoredRecord {
  recordId: string;
  recordType: string;
  state: string;
  payloadJson: string;
  recordRevision: number;
  createdAt: number;
  updatedAt: number;
}

const fakeKernel = () => {
  const records = new Map<string, StoredRecord>();
  const scopedClient = {
    async getRecord(workspaceId: string, recordId: string): Promise<KernelRecordResult | null> {
      const stored = records.get(`${workspaceId}:${recordId}`);
      return stored ? { ...stored } as unknown as KernelRecordResult : null;
    },
    async putRecord(params: {
      recordId: string; recordType: string; state: string; payloadJson: string;
      workspaceId: string; expectedRecordRevision?: number;
    }): Promise<KernelRecordResult> {
      const key = `${params.workspaceId}:${params.recordId}`;
      const existing = records.get(key);
      if (params.expectedRecordRevision !== undefined && params.expectedRecordRevision !== existing?.recordRevision) {
        throw new Error("revision conflict");
      }
      const stored: StoredRecord = {
        recordId: params.recordId,
        recordType: params.recordType,
        state: params.state,
        payloadJson: params.payloadJson,
        recordRevision: (existing?.recordRevision ?? 0) + 1,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      records.set(key, stored);
      return { ...stored } as unknown as KernelRecordResult;
    },
    async listRecords(params: { workspaceId: string; recordType: string; cursor?: number; pageSize?: number }) {
      const all = [...records.values()].filter(
        (r) => r.recordType === params.recordType && `${params.workspaceId}:${r.recordId}` === `${params.workspaceId}:${r.recordId}`,
      ).filter((r) => records.has(`${params.workspaceId}:${r.recordId}`));
      const start = params.cursor ?? 0;
      const page = all.slice(start, start + (params.pageSize ?? 100));
      return {
        records: page.map((r) => ({ ...r })) as unknown as KernelRecordResult[],
        nextCursor: start + page.length < all.length ? start + page.length : null,
      };
    },
  };
  return {
    client: {
      issueGrant: async () => ({ grantId: "g-1" }),
      scoped: () => scopedClient,
    },
    records,
  };
};

interface FakeDriver extends ComputerDriverSession {
  calls: Array<Record<string, unknown>>;
  handler: (op: Record<string, unknown>) => Promise<DriverResponse>;
}

const makeDriver = (handler: FakeDriver["handler"]): FakeDriver => {
  const driver: FakeDriver = {
    calls: [],
    handler,
    capabilities: null,
    alive: () => true,
    dispose: () => undefined,
    cancel: () => true,
    request: async (op) => {
      driver.calls.push(op as Record<string, unknown>);
      return driver.handler(op as Record<string, unknown>);
    },
  };
  return driver;
};

const okResponse = (extra: Partial<DriverResponse> = {}): DriverResponse => ({ id: "x", ok: true, ...extra });

const appSnapshot = () => ({
  app: { name: "notepad", pid: 42, windowTitle: "Untitled - Notepad" },
  windowBounds: { x: 10, y: 10, width: 800, height: 600 },
  treeLines: ["window Untitled - Notepad"],
  elements: [
    { index: 0, name: "Text editor", controlType: "Edit", frame: { x: 0, y: 0, width: 780, height: 560 } },
    { index: 1, name: "Save", controlType: "Button", actions: ["Invoke"] },
  ],
});

let dirs: string[] = [];
const newDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "varin-computer-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const dir of dirs) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

const makeService = (driver?: FakeDriver) => {
  const kernel = fakeKernel();
  let spec: DriverSpawnSpec | null = null;
  const service = createComputerService({
    client: kernel.client as never,
    hostId: "host-1",
    platform: "windows",
    dataDir: newDataDir(),
    createDriver: (s) => { spec = s; return driver ?? makeDriver(async () => okResponse()); },
  });
  return { service, kernel, getSpec: () => spec };
};

describe("computer service (BC4)", () => {
  it("ensureLocal writes durable machine and desktop records", async () => {
    const { service } = makeService();
    await service.ensureLocal();
    const catalog = await service.list();
    expect(catalog.machines.map((m) => m.id)).toContain("local");
    expect(catalog.desktops.map((d) => d.id)).toContain("local-console");
    expect(catalog.machines[0]?.coordinatorHostId).toBe("host-1");
  });

  it("probe stores the driver's real capability table on the desktop record", async () => {
    const driver = makeDriver(async (op) => op.tool === "capabilities"
      ? okResponse({ capabilities: { platform: "windows", driver: "windows-uia", observeTree: true, screenshot: true, elementAction: true, coordinateInput: true, textInput: true, drag: true, status: "ready" } })
      : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const desktop = await service.probe("local-console");
    expect(desktop.status).toBe("available");
    expect(desktop.capabilities?.driver).toBe("windows-uia");
    expect(desktop.capabilities?.coordinateInput).toBe(true);
  });

  it("a failed probe marks the desktop unavailable with the real reason", async () => {
    const driver = makeDriver(async () => ({ id: "x", ok: false, error: "no graphical session" }));
    const { service } = makeService(driver);
    await service.ensureLocal();
    await expect(service.probe("local-console")).rejects.toMatchObject({ harnessCode: "unavailable" });
    const { desktops } = await service.list();
    expect(desktops[0]?.status).toBe("unavailable");
    expect(desktops[0]?.statusDetail).toContain("no graphical session");
  });

  it("element actions replay the observed element record to the driver", async () => {
    const driver = makeDriver(async (op) => {
      if (op.tool === "get_app_state") return okResponse({ snapshot: appSnapshot() });
      if (op.tool === "click") return okResponse({ text: "invoked" });
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();
    const observation = await service.observe({ desktopId: "local-console", app: "notepad", includeScreenshot: false });
    const result = await service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", elementIndex: 1, observationId: observation.id },
    });
    expect(result.accepted).toBe(true);
    const click = driver.calls.find((c) => c.tool === "click");
    expect(click?.element).toMatchObject({ index: 1, name: "Save" });
    expect(click?.windowBounds).toMatchObject({ width: 800 });
  });

  it("a stale observationId is rejected instead of firing blind", async () => {
    const driver = makeDriver(async (op) =>
      op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() }) : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const first = await service.observe({ desktopId: "local-console", app: "notepad" });
    await service.observe({ desktopId: "local-console", app: "notepad" });
    await expect(service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", elementIndex: 1, observationId: first.id },
    })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    expect(driver.calls.filter((c) => c.tool === "click")).toHaveLength(0);
  });

  it("element actions without any observation are rejected", async () => {
    const { service } = makeService(makeDriver(async () => okResponse()));
    await service.ensureLocal();
    await expect(service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", elementIndex: 1 },
    })).rejects.toMatchObject({ harnessCode: "invalid-params" });
  });

  it("reports a lost action response as unknown and does not replay the input", async () => {
    const driver = makeDriver(async () => { throw new Error("driver connection lost"); });
    const { service } = makeService(driver);
    await service.ensureLocal();
    const result = await service.act({ desktopId: "local-console", action: { kind: "type", app: "x", text: "hello" } });
    expect(result).toMatchObject({ accepted: false, outcome: "unknown" });
    expect(driver.calls.filter((op) => op.tool === "type_text")).toHaveLength(1);
  });

  it("cancel drops queued actions and releases held input after the in-flight op", async () => {
    let releaseResolve: (r: DriverResponse) => void = () => undefined;
    const order: string[] = [];
    const driver = makeDriver(async (op) => {
      order.push(op.tool as string);
      if (op.tool === "type_text") {
        return new Promise<DriverResponse>((resolve) => { releaseResolve = resolve; });
      }
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();
    const slow = service.act({ desktopId: "local-console", action: { kind: "type", app: "x", text: "hello" } });
    const queued = service.act({ desktopId: "local-console", action: { kind: "key", app: "x", key: "enter" } });
    // Let the second act finish its driver resolution and land on the lane.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let cancelFinished = false;
    const cancellation = service.cancel("local-console").then((result) => { cancelFinished = true; return result; });
    expect(await queued).toMatchObject({ accepted: false, cancelled: true });
    expect(cancelFinished).toBe(false);
    releaseResolve(okResponse());
    expect((await cancellation).cancelled).toBe(1);
    const slowResult = await slow;
    expect(slowResult.cancelled).toBe(true);
    // release_input is issued on the lane so interrupted input cannot linger.
    // (index 0 is the driver-generation sweep issued when the driver spawned —
    // the cancel cleanup is the release that follows the in-flight type_text.)
    expect(order).toContain("release_input");
    expect(order.lastIndexOf("release_input")).toBeGreaterThan(order.indexOf("type_text"));
  });

  it("a driver-side mid-operation cancel reports a partial outcome, not failure", async () => {
    const driver = makeDriver(async (op) => op.tool === "type_text"
      ? { id: "x", ok: false, cancelled: true, error: "cancelled (typed 12 of 40 characters)" }
      : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const result = await service.act({
      desktopId: "local-console",
      action: { kind: "type", app: "x", text: "x".repeat(40) },
    });
    expect(result.accepted).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.outcome).toBe("partial");
    expect(result.detail).toContain("12 of 40");
  });

  it("forwards an aborted action request to the in-flight native driver", async () => {
    let finish!: (response: DriverResponse) => void;
    let cancelCalls = 0;
    const driver = makeDriver(async (op) => op.tool === "type_text"
      ? new Promise<DriverResponse>((resolve) => { finish = resolve; })
      : okResponse());
    driver.cancel = () => {
      cancelCalls += 1;
      finish({ id: "x", ok: false, cancelled: true, error: "cancelled (typed 2 of 5 characters)" });
      return true;
    };
    const { service } = makeService(driver);
    const controller = new AbortController();
    const pending = service.act({
      desktopId: "local-console", action: { kind: "type", app: "notepad", text: "hello" },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.calls.some((call) => call.tool === "type_text")).toBe(true));
    controller.abort();
    expect(await pending).toMatchObject({ accepted: false, cancelled: true, outcome: "partial" });
    expect(cancelCalls).toBe(1);
  });

  it("observe passes the window selector through and binds actions to the observed hwnd", async () => {
    const snapshot = {
      ...appSnapshot(),
      elements: appSnapshot().elements.map((element) => element.index === 1 ? { ...element, path: [3, 1] } : element),
      windowHandle: 778812,
      windows: [
        { handle: 778811, title: "Document A", main: false },
        { handle: 778812, title: "Document B", main: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ],
    };
    const driver = makeDriver(async (op) =>
      op.tool === "get_app_state" ? okResponse({ snapshot }) : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const observation = await service.observe({
      desktopId: "local-console", app: "notepad", includeScreenshot: false, window: 778812,
    });
    expect(observation.windowHandle).toBe(778812);
    expect(observation.windows).toHaveLength(2);
    const observeOp = driver.calls.find((c) => c.tool === "get_app_state");
    expect(observeOp?.window).toBe(778812);
    // The action binds the observed hwnd even without an explicit selector.
    await service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", elementIndex: 1, observationId: observation.id },
    });
    const click = driver.calls.find((c) => c.tool === "click");
    expect(click?.window).toBe(778812);
    expect(click?.element).toMatchObject({ path: [3, 1] });
    await expect(service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", window: 778811, elementIndex: 1, observationId: observation.id },
    })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    expect(driver.calls.filter((c) => c.tool === "click")).toHaveLength(1);
  });

  it("listApps reports the driver's per-process window inventory", async () => {
    const driver = makeDriver(async (op) => op.tool === "list_apps"
      ? okResponse({ apps: [{
          name: "notepad", pid: 42, windowTitle: "Document B",
          windows: [
            { handle: 0, title: "Document A" },
            { handle: 102, title: "Document B", main: true },
          ],
        }] })
      : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const apps = await service.listApps("local-console");
    expect(apps[0]?.windows?.map((w) => w.handle)).toEqual([0, 102]);
    expect(apps[0]?.windows?.[1]?.main).toBe(true);
  });

  it("retains a zero-based Linux window selector through observation and action", async () => {
    const driver = makeDriver(async (op) => op.tool === "get_app_state"
      ? okResponse({ snapshot: {
          ...appSnapshot(), windowHandle: 0,
          windows: [{ handle: 0, title: "Document A", main: true }],
        } })
      : okResponse());
    const { service } = makeService(driver);
    const observation = await service.observe({ desktopId: "local-console", app: "notepad", window: 0 });
    expect(observation.windowHandle).toBe(0);
    expect(observation.windows?.[0]?.handle).toBe(0);
    await service.act({
      desktopId: "local-console",
      action: { kind: "click", app: "notepad", elementIndex: 1, observationId: observation.id },
    });
    expect(driver.calls.find((call) => call.tool === "click")?.window).toBe(0);
  });

  it("default target persists under the host data dir and validates existence", async () => {
    const kernel = fakeKernel();
    const dataDir = newDataDir();
    const service = createComputerService({
      client: kernel.client as never, hostId: "host-1", platform: "windows", dataDir,
      createDriver: () => makeDriver(async () => okResponse()),
    });
    await service.ensureLocal();
    await service.setDefaultDesktop("local-console");
    expect(await service.defaultDesktop()).toBe("local-console");
    expect(JSON.parse(readFileSync(join(dataDir, "computer-target.json"), "utf8")).desktopId).toBe("local-console");
    // A fresh service instance reads the same persisted target.
    const service2 = createComputerService({
      client: kernel.client as never, hostId: "host-1", platform: "windows", dataDir,
      createDriver: () => makeDriver(async () => okResponse()),
    });
    expect(await service2.defaultDesktop()).toBe("local-console");
    await expect(service.setDefaultDesktop("ghost")).rejects.toMatchObject({ harnessCode: "not-found" });
    service.dispose();
    service2.dispose();
  });

  it("the local console desktop resolves implicitly when it is the only desktop", async () => {
    const driver = makeDriver(async (op) =>
      op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() }) : okResponse());
    const { service } = makeService(driver);
    expect((await service.list()).desktops.map((desktop) => desktop.id)).toEqual(["local-console"]);
    const observation = await service.observe({ app: "notepad" });
    expect(observation.desktopId).toBe("local-console");
    expect(observation.elements).toHaveLength(2);
  });
});

describe("computer service (BC5 control + view)", () => {
  const desktopId = "local-console";

  it("defaults to agent control and exposes the control record", async () => {
    const { service } = makeService();
    await service.ensureLocal();
    const control = await service.control(desktopId);
    expect(control).toMatchObject({ desktopId, owner: "agent", reachable: true });
  });

  it("takeover drops queued actions, releases input, and blocks new automation", async () => {
    let releaseResolve: (r: DriverResponse) => void = () => undefined;
    let cancelled = false;
    const order: string[] = [];
    const driver = makeDriver(async (op) => {
      order.push(op.tool as string);
      if (op.tool === "type_text") {
        return new Promise<DriverResponse>((resolve) => { releaseResolve = resolve; });
      }
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();
    const slow = service.act({ desktopId, action: { kind: "type", app: "x", text: "hello" } });
    const queued = service.act({ desktopId, action: { kind: "key", app: "x", key: "enter" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The takeover's release_input serializes behind the in-flight type op —
    // resolve the takeover only after letting the slow op finish.
    const takeoverPromise = service.takeover({ desktopId, holderId: "viewer-1" });
    expect((await queued).cancelled).toBe(true);
    releaseResolve(okResponse());
    const takeover = await takeoverPromise;
    expect(takeover.control.owner).toBe("human");
    expect(takeover.control.holderId).toBe("viewer-1");
    expect(takeover.cancelled).toBe(1);
    expect((await queued).cancelled).toBe(true);
    const slowResult = await slow;
    // The in-flight op settled after the takeover — stamped with the old
    // generation it reports cancelled rather than resuming under human control.
    expect(slowResult.cancelled).toBe(true);
    cancelled = true;
    await expect(service.act({ desktopId, action: { kind: "key", app: "x", key: "enter" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(order.lastIndexOf("release_input")).toBeGreaterThan(-1);
    expect(cancelled).toBe(true);
  });

  it("human input passes only while the viewer holds control", async () => {
    const driver = makeDriver(async () => okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    await expect(service.input({ desktopId, holderId: "v1", input: { kind: "click", x: 5, y: 6 } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    await service.takeover({ desktopId, holderId: "v1" });
    const result = await service.input({ desktopId, holderId: "v1", input: { kind: "click", x: 5, y: 6 } });
    expect(result.accepted).toBe(true);
    const injected = driver.calls.find((call) => call.tool === "inject_input");
    expect(injected).toMatchObject({ kind: "click", x: 5, y: 6 });
    // Another viewer may not write while v1 holds.
    await expect(service.input({ desktopId, holderId: "v2", input: { kind: "key", key: "enter" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
  });

  it("handback returns control to the agent and invalidates stale observations", async () => {
    const driver = makeDriver(async (op) =>
      op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() }) : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const observation = await service.observe({ desktopId, app: "notepad" });
    await service.takeover({ desktopId, holderId: "v1" });
    const back = await service.handback({ desktopId, holderId: "v1" });
    expect(back.control.owner).toBe("agent");
    expect(back.requiresObservation).toBe(true);
    // The pre-takeover observation is dead — indexes from it must not fire.
    await expect(service.act({
      desktopId,
      action: { kind: "click", app: "notepad", observationId: observation.id, elementIndex: 1 },
    })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await service.observe({ desktopId, app: "notepad" });
    const result = await service.act({ desktopId, action: { kind: "key", app: "notepad", key: "enter" } });
    expect(result.accepted).toBe(true);
  });

  it("holder disconnect keeps control human-owned and unreachable until reconnect", async () => {
    const driver = makeDriver(async (op) =>
      op.tool === "capture_frame"
        ? okResponse({ frame: { mime: "image/png", base64: "AA==", bounds: { x: 0, y: 0, width: 8, height: 8 } } })
        : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const events: string[] = [];
    const unsubscribe = await service.subscribeFrames(desktopId, "v1", (event) => events.push(event.type));
    await service.takeover({ desktopId, holderId: "v1" });
    unsubscribe();
    let control = await service.control(desktopId);
    // Viewer closed — control stays human-owned but pending recovery.
    expect(control).toMatchObject({ owner: "human", holderId: "v1", reachable: false });
    await expect(service.input({ desktopId, holderId: "v1", input: { kind: "key", key: "enter" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    // Reconnect with the same viewer id restores reachability — not ownership.
    await service.subscribeFrames(desktopId, "v1", () => undefined);
    control = await service.control(desktopId);
    expect(control.reachable).toBe(true);
    expect(events).toContain("control");
  });

  it("frame subscribers get frames without touching the action lane", async () => {
    const driver = makeDriver(async (op) =>
      op.tool === "capture_frame"
        ? okResponse({ frame: { mime: "image/jpeg", base64: "QUJD", bounds: { x: 0, y: 0, width: 64, height: 48 }, capturedAt: "t0" } })
        : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = await service.subscribeFrames(desktopId, "a", (e) => { if (e.type === "frame") seenA.push(e.frame.mime); });
    const unsubB = await service.subscribeFrames(desktopId, "b", (e) => { if (e.type === "frame") seenB.push(e.frame.mime); });
    await new Promise((resolve) => setTimeout(resolve, 600));
    unsubA();
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenB.length).toBeGreaterThan(0);
    expect(seenA[0]).toBe("image/jpeg");
    // One viewer leaving keeps the other subscribed and the task untouched.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = seenB.length;
    unsubB();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seenB.length).toBe(after); // no frames after the last unsubscribe
    const frames = driver.calls.filter((call) => call.tool === "capture_frame").length;
    expect(frames).toBeGreaterThan(0);
  });
});

describe("computer service (BC6 remote hosts)", () => {
  const remoteHost = { id: "r1", label: "Office PC", apiUrl: "http://10.0.0.5:8765", clientToken: "tok-1" };
  const remoteCatalog = {
    machines: [{ id: "local", name: "Office PC", provider: "local", platform: "linux", coordinatorHostId: "remote-h", status: "active", createdAt: "t", updatedAt: "t" }],
    desktops: [{ id: "d0", machineId: "local", label: "Console session", kind: "console", status: "available" }],
    defaultDesktopId: "d0",
  };

  const remoteFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (
    (async (input: unknown, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch
  );

  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

  it("mirrors a configured remote Host's desktops into the local catalog", async () => {
    const withRemote = createComputerService({
      client: fakeKernel().client as never,
      hostId: "host-1",
      platform: "windows",
      dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url) => {
        expect(String(url)).toContain("10.0.0.5");
        return jsonResponse(remoteCatalog);
      }),
    });
    const catalog = await withRemote.list();
    const remoteMachine = catalog.machines.find((m) => m.id === "remote:r1");
    expect(remoteMachine?.provider).toBe("remote");
    expect(remoteMachine?.platform).toBe("linux");
    const mirrored = catalog.desktops.find((d) => d.id === "remote:r1:d0");
    expect(mirrored?.remote).toEqual({ connectionId: "r1", desktopId: "d0" });
    expect(mirrored?.status).toBe("available");
  });

  it("marks an unreachable remote Host's mirror unavailable with the real error", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never,
      hostId: "host-1",
      platform: "windows",
      dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      remoteHosts: async () => [remoteHost],
      fetch: remoteFetch(() => { throw new Error("connect ECONNREFUSED"); }),
    });
    const catalog = await service.list();
    const remoteMachine = catalog.machines.find((m) => m.id === "remote:r1");
    expect(remoteMachine?.status).toBe("unavailable");
    expect(remoteMachine?.statusDetail).toContain("ECONNREFUSED");
  });

  it("routes observe/act to the remote desktop and keeps the remote observation id", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const service = createComputerService({
      client: fakeKernel().client as never,
      hostId: "host-1",
      platform: "windows",
      dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      remoteHosts: async () => [remoteHost],
      fetch: remoteFetch(async (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        seen.push({ url, body });
        if (url.endsWith("/api/computers")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/observe")) {
          return jsonResponse({ observation: {
            id: "remote-obs-9", desktopId: "d0", machineId: "local",
            app: { name: "term", pid: 7 }, treeLines: [], elements: [{ index: 0, name: "ok" }], capturedAt: "t",
          } });
        }
        if (url.endsWith("/act")) {
          return jsonResponse({ result: { accepted: true, detail: "done" } });
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    });
    await service.list(); // mirrors the catalog
    const observation = await service.observe({ desktopId: "remote:r1:d0", app: "term" });
    expect(observation.id).toBe("remote-obs-9"); // remote freshness id preserved
    const result = await service.act({
      desktopId: "remote:r1:d0",
      action: { kind: "click", app: "term", observationId: observation.id, elementIndex: 0 },
    });
    expect(result.accepted).toBe(true);
    // The remote Host validates the element index against ITS observation —
    // the forwarded action must carry the remote observation id verbatim.
    const actCall = seen.find((entry) => entry.url.endsWith("/act"));
    expect(actCall?.body.action).toMatchObject({ kind: "click", observationId: "remote-obs-9", elementIndex: 0 });
  });

  it("a transport failure on remote act reports unknown — never a replay", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never,
      hostId: "host-1",
      platform: "windows",
      dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url) => {
        if (url.endsWith("/api/computers")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/act")) throw new Error("socket hang up");
        return jsonResponse({});
      }),
    });
    await service.list();
    const result = await service.act({ desktopId: "remote:r1:d0", action: { kind: "key", app: "term", key: "enter" } });
    expect(result).toMatchObject({ accepted: false, outcome: "unknown" });
    expect(result.detail).toContain("socket hang up");
  });
});

// --- BC7: virtual machine lifecycle -----------------------------------------

import type { VmExec } from "./vm-provider.js";

describe("computer service (BC7 virtual machines)", () => {
  const vmProviderConfig = {
    id: "hv1",
    kind: "libvirt" as const,
    uri: "qemu:///system",
  };

  const fakeVirsh = (
    script: (args: string[]) => { code?: number; stdout?: string; stderr?: string },
  ) => {
    const calls: string[][] = [];
    const exec: VmExec = async (_command, args, options) => {
      void options;
      const scriptArgs = args.slice(2); // strip `-c uri`
      calls.push(scriptArgs);
      const reply = script(scriptArgs);
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    };
    return { exec, calls };
  };

  const makeVmService = (exec: VmExec) => {
    const kernel = fakeKernel();
    const service = createComputerService({
      client: kernel.client as never,
      hostId: "host-1",
      platform: "windows",
      dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      vmProviders: async () => [vmProviderConfig],
      vmExec: exec,
    });
    return { service, kernel };
  };

  it("create records provider identity, domain UUID, volumes, and the step journal", async () => {
    let domuuidCalls = 0;
    const { exec, calls } = fakeVirsh((args) => {
      if (args[0] === "domuuid") {
        domuuidCalls += 1;
        return domuuidCalls === 1
          ? { code: 1, stderr: "error: failed to get domain 'devbox'" }
          : { stdout: "1111aaaa-2222-3333-4444-555566667777\n" };
      }
      if (args[0] === "vol-create-as") return { stdout: "Vol devbox.qcow2 created\n" };
      if (args[0] === "define") return { stdout: "Domain devbox defined\n" };
      if (args[0] === "domstate") return { stdout: "shut off\n" };
      throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    });
    const { service, kernel } = makeVmService(exec);

    const { machine, created } = await service.createVm({
      providerId: "hv1",
      name: "devbox",
      memoryMiB: 2048,
      vcpus: 2,
      diskGiB: 20,
    });
    expect(created).toBe(true);
    expect(machine.provider).toBe("virtual");
    expect(machine.vm).toMatchObject({
      providerId: "hv1",
      kind: "libvirt",
      uri: "qemu:///system",
      domainUuid: "1111aaaa-2222-3333-4444-555566667777",
      volumePaths: ["devbox.qcow2"],
    });
    expect(machine.vm!.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "resolve:done", "volume:done", "define:done",
    ]);
    // A shutoff domain is not an active machine.
    expect(machine.status).toBe("unavailable");
    expect(machine.statusDetail).toContain("shut off");

    // The record persists in the catalog — durable journal, not memory.
    const stored = await kernel.client.scoped()
      .getRecord("__varin_computers__", `computer.machine:${machine.id}`);
    expect(JSON.parse(stored!.payloadJson).vm.domainUuid).toBe("1111aaaa-2222-3333-4444-555566667777");
    expect(calls.some((args) => args[0] === "define")).toBe(true);
  });

  it("a retried create adopts the existing domain — no duplicate volume/define", async () => {
    const { exec, calls } = fakeVirsh((args) => {
      if (args[0] === "domuuid") return { stdout: "1111aaaa-2222-3333-4444-555566667777\n" };
      if (args[0] === "domblklist") return { stdout: " vda   default/devbox.qcow2\n" };
      if (args[0] === "domstate") return { stdout: "running\n" };
      throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    });
    const { service } = makeVmService(exec);

    const { machine, created } = await service.createVm({ providerId: "hv1", name: "devbox" });
    expect(created).toBe(false);
    expect(machine.vm!.domainUuid).toBe("1111aaaa-2222-3333-4444-555566667777");
    expect(machine.status).toBe("active"); // real domstate: running
    expect(calls.some((args) => args[0] === "vol-create-as")).toBe(false);
    expect(calls.some((args) => args[0] === "define")).toBe(false);
  });

  it("start/shutdown key on the recorded domain UUID and sync status", async () => {
    let state = "shut off";
    const { exec, calls } = fakeVirsh((args) => {
      if (args[0] === "domuuid") return { stdout: "1111aaaa-2222-3333-4444-555566667777\n" };
      if (args[0] === "domblklist") return { stdout: " vda   default/devbox.qcow2\n" };
      if (args[0] === "domstate") return { stdout: `${state}\n` };
      if (args[0] === "start") { state = "running"; return { stdout: "started\n" }; }
      if (args[0] === "shutdown") { state = "shut off"; return { stdout: "shutting down\n" }; }
      throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    });
    const { service } = makeVmService(exec);

    // Seed the machine record via an adoption create.
    await service.createVm({ providerId: "hv1", name: "devbox" });

    const started = await service.vmAction({ machineId: "vm:hv1:devbox", action: "start" });
    expect(started.state).toBe("running");
    expect(calls.some((args) => args[0] === "start" && args[1] === "1111aaaa-2222-3333-4444-555566667777")).toBe(true);

    const stopped = await service.vmAction({ machineId: "vm:hv1:devbox", action: "shutdown" });
    expect(stopped.state).toBe("shutoff");
    expect(calls.some((args) => args[0] === "shutdown" && args[1] === "1111aaaa-2222-3333-4444-555566667777")).toBe(true);
  });

  it("delete archives the record and only removes disks when asked", async () => {
    const deleted: string[] = [];
    const { exec } = fakeVirsh((args) => {
      if (args[0] === "domuuid") return { stdout: "1111aaaa-2222-3333-4444-555566667777\n" };
      if (args[0] === "domblklist") return { stdout: " vda   default/devbox.qcow2\n" };
      if (args[0] === "domstate") return { stdout: "shut off\n" };
      if (args[0] === "undefine") return { stdout: "undefined\n" };
      if (args[0] === "vol-delete") { deleted.push(args[args.length - 1]!); return { stdout: "deleted\n" }; }
      throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    });
    const { service } = makeVmService(exec);
    const { machine } = await service.createVm({ providerId: "hv1", name: "devbox" });

    // Default delete: persistent disk survives.
    await service.deleteVm(machine.id, false);
    expect(deleted).toEqual([]);

    const vms = await service.listVms();
    expect(vms).toEqual([]); // archived machines leave the VM list
  });

  it("a failed create persists the journal on an unavailable machine record", async () => {
    const { exec } = fakeVirsh((args) => {
      if (args[0] === "domuuid") return { code: 1, stderr: "no domain" };
      if (args[0] === "vol-create-as") return { stdout: "created\n" };
      if (args[0] === "define") return { code: 1, stderr: "invalid domain XML" };
      if (args[0] === "vol-delete") return { stdout: "deleted\n" };
      throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    });
    const { service } = makeVmService(exec);
    await expect(service.createVm({ providerId: "hv1", name: "broken" })).rejects.toThrow(/define/);
    const catalog = await service.list();
    const machine = catalog.machines.find((m) => m.name === "broken");
    expect(machine).toBeDefined();
    expect(machine!.status).toBe("unavailable");
    expect(machine!.vm!.steps.map((s) => `${s.step}:${s.status}`)).toContain("define:failed");
    expect(machine!.vm!.steps.map((s) => `${s.step}:${s.status}`)).toContain("cleanup:done");
  });
});

describe("computer service work association (BC8)", () => {
  it("observe/act stamp the calling session on the desktop record", async () => {
    const driver = makeDriver(async (op) => {
      if (op.tool === "get_app_state") return okResponse({ snapshot: appSnapshot() });
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();

    let catalog = await service.list();
    expect(catalog.desktops[0]?.usage).toBeUndefined();

    await service.observe({ desktopId: "local-console", app: "notepad", includeScreenshot: false, sessionId: "ses_work-1" });
    catalog = await service.list();
    expect(catalog.desktops[0]?.usage?.sessionId).toBe("ses_work-1");

    const observation = catalog.desktops[0] && (await service.observe({ desktopId: "local-console", app: "notepad", includeScreenshot: false }));
    await service.act({
      desktopId: "local-console",
      action: { kind: "key", app: "notepad", key: "enter" },
      sessionId: "ses_work-2",
    });
    catalog = await service.list();
    expect(catalog.desktops[0]?.usage?.sessionId).toBe("ses_work-2");
    expect(observation).toBeDefined();
  });

  it("a probe rewrite preserves the recorded usage association", async () => {
    const driver = makeDriver(async (op) => {
      if (op.tool === "get_app_state") return okResponse({ snapshot: appSnapshot() });
      if (op.tool === "capabilities") return okResponse({ capabilities: { platform: "windows", driver: "windows-uia", observeTree: true, status: "ready" } });
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();
    await service.observe({ desktopId: "local-console", app: "notepad", includeScreenshot: false, sessionId: "ses_keep" });
    await service.probe("local-console");
    const catalog = await service.list();
    expect(catalog.desktops[0]?.usage?.sessionId).toBe("ses_keep");
  });
});
