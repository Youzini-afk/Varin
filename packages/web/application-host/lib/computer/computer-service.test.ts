import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

const okResponse = (extra: Record<string, unknown> = {}): DriverResponse => ({ id: "x", ok: true, ...extra });

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
  it("automation cancel/release cannot lift buttons owned by a human viewer", async () => {
    const driver = makeDriver(async () => okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const unsubscribe = await service.subscribeFrames("local-console", "human", () => {}, { frames: false });
    await service.takeover({ desktopId: "local-console", holderId: "human" });
    const control = await service.control("local-console");
    await service.input({ desktopId: "local-console", holderId: "human", controlEpoch: control.automationEpoch, input: { kind: "down", x: 1, y: 2, button: "left" } });
    const before = driver.calls.length;
    expect(await service.cancel("local-console")).toEqual({ cancelled: 0, released: false });
    await expect(service.release("local-console")).rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(driver.calls.slice(before)).toEqual([]);
    expect((await service.control("local-console")).automationEpoch).toBe(control.automationEpoch);
    expect(await service.input({ desktopId: "local-console", holderId: "human", controlEpoch: control.automationEpoch, input: { kind: "up", x: 1, y: 2, button: "left" } })).toMatchObject({ accepted: true });
    unsubscribe(); await service.dispose();
  });

  it("keeps live frames flowing on a separate helper while native input is still running", async () => {
    const kernel = fakeKernel();
    let finishAction!: () => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => { started = resolve; });
    const roles: string[] = [];
    const service = createComputerService({ client: kernel.client as never, hostId: "host-1", platform: "windows", dataDir: newDataDir(),
      createDriver: (spec) => {
        const role = spec.env?.VARIN_DRIVER_ROLE ?? "";
        roles.push(role);
        return makeDriver(async (op) => {
          if (op.tool === "type_text") {
            expect(role).toBe("input");
            started(); await new Promise<void>((resolve) => { finishAction = resolve; });
          }
          if (op.tool === "capture_frame") {
            expect(role).toBe("capture");
            return okResponse({ frame: { base64: "frame", bounds: { x: 0, y: 0, width: 800, height: 600 } } });
          }
          return okResponse();
        });
      },
    });
    const action = service.act({ desktopId: "local-console", action: { kind: "type", app: "notepad", text: "long input" } });
    await actionStarted;
    let sawFrame!: () => void;
    const frame = new Promise<void>((resolve) => { sawFrame = resolve; });
    const unsubscribe = await service.subscribeFrames("local-console", "viewer", (event) => { if (event.type === "frame") sawFrame(); });
    try {
      await frame;
      expect(roles).toEqual(["input", "capture"]);
    } finally { finishAction(); await action; unsubscribe(); await service.dispose(); }
  });

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
    const driver = makeDriver(async (op) => {
      if (op.tool === "type_text") throw new Error("driver connection lost");
      return okResponse();
    });
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
    const unsubscribe = await service.subscribeFrames(desktopId, "v1", () => undefined);
    await service.takeover({ desktopId, holderId: "v1" });
    const result = await service.input({ desktopId, holderId: "v1", input: { kind: "click", x: 5, y: 6 } });
    expect(result.accepted).toBe(true);
    const injected = driver.calls.find((call) => call.tool === "inject_input");
    expect(injected).toMatchObject({ kind: "click", x: 5, y: 6 });
    // Another viewer may not write while v1 holds.
    await expect(service.input({ desktopId, holderId: "v2", input: { kind: "key", key: "enter" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    await expect(service.input({ desktopId, input: { kind: "key", key: "enter" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    await expect(service.handback({ desktopId })).rejects.toMatchObject({ harnessCode: "forbidden" });
    unsubscribe();
    await service.dispose();
  });

  it("fences automation during release and rejects a pre-handoff script after handback", async () => {
    let finishRelease: ((value: DriverResponse) => void) | undefined;
    let holdRelease = false;
    const driver = makeDriver(async (op) => {
      if (op.tool === "release_input" && holdRelease) return new Promise<DriverResponse>((resolve) => { finishRelease = resolve; });
      return op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() }) : okResponse();
    });
    const { service } = makeService(driver);
    await service.observe({ desktopId, app: "notepad" });
    const oldEpoch = (await service.control(desktopId)).automationEpoch;
    holdRelease = true;
    const taking = service.takeover({ desktopId, holderId: "v1" });
    await vi.waitFor(() => expect(finishRelease).toBeDefined());
    await expect(service.act({ desktopId, action: { kind: "key", app: "notepad", key: "enter" } })).rejects.toMatchObject({ harnessCode: "forbidden" });
    finishRelease!(okResponse());
    await taking;
    holdRelease = false;
    await service.handback({ desktopId, holderId: "v1" });
    await service.observe({ desktopId, app: "notepad" });
    await expect(service.act({ desktopId, automationEpoch: oldEpoch, action: { kind: "key", app: "notepad", key: "enter" } })).rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(driver.calls.some((call) => call.tool === "press_key")).toBe(false);
    await service.dispose();
  });

  it("retains human ownership across Host restart and refuses handback when release fails", async () => {
    const kernel = fakeKernel();
    const driver = makeDriver(async () => okResponse());
    const options = { client: kernel.client as never, hostId: "h", platform: "windows" as const, dataDir: newDataDir(), createDriver: () => driver };
    const first = createComputerService(options);
    await first.observe({ desktopId, app: "notepad" }).catch(() => undefined);
    await first.takeover({ desktopId, holderId: "v1" });
    driver.handler = async () => ({ id: "x", ok: false, error: "release failed" });
    await expect(first.handback({ desktopId, holderId: "v1" })).rejects.toThrow(/release/i);
    await first.dispose();
    const restarted = createComputerService(options);
    expect(await restarted.control(desktopId)).toMatchObject({ owner: "human", holderId: "v1", reachable: false });
    await expect(restarted.act({ desktopId, action: { kind: "key", app: "notepad", key: "enter" } })).rejects.toMatchObject({ harnessCode: "forbidden" });
    await restarted.dispose();
  });

  it("an old subscription closing does not disconnect its replacement", async () => {
    const { service } = makeService();
    const old = await service.subscribeFrames(desktopId, "v1", () => undefined);
    const current = await service.subscribeFrames(desktopId, "v1", () => undefined);
    await service.takeover({ desktopId, holderId: "v1" });
    old();
    expect((await service.control(desktopId)).reachable).toBe(true);
    current();
    expect((await service.control(desktopId)).reachable).toBe(false);
    await service.dispose();
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
    headers: { "Content-Type": "application/json", "X-Varin-Computer-Host": "remote-h" },
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
    const mirrored = catalog.desktops.find((d) => d.id === "remote:r1:remote-h:d0");
    expect(mirrored?.remote).toEqual({ connectionId: "r1", desktopId: "d0", hostId: "remote-h" });
    expect(mirrored?.status).toBe("available");
  });

  it("rediscovers a just-prepared remote desktop despite the catalog refresh interval", async () => {
    let prepared = false;
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url) => {
        if (url.endsWith("/api/computers/desktops/prepare")) {
          prepared = true;
          return jsonResponse({ desktop: { id: "managed-linux" } });
        }
        if (url.endsWith("/api/computers?local=1")) return jsonResponse({ ...remoteCatalog,
          desktops: prepared ? [...remoteCatalog.desktops, { id: "managed-linux", machineId: "local", label: "Persistent Linux desktop",
            kind: "virtual-display", status: "available", managed: "linux-xvnc", media: { kind: "vnc", width: 1280, height: 800 } }] : remoteCatalog.desktops });
        return jsonResponse({});
      }),
    });
    await service.list();
    const desktop = await service.prepareDesktop({ connectionId: "r1" });
    expect(desktop.remote?.desktopId).toBe("managed-linux");
    expect(desktop.media).toEqual({ kind: "vnc", width: 1280, height: 800 });
    await service.dispose();
  });

  it("records a remote desktop file revision on its Thread and streams only that revision", async () => {
    const bytes = Buffer.from("artifact content");
    const sha256 = "42bd420cc2f99e68e60005fa7c28fc2f60e4e04ee160d9dd3b98e72fc2954f98";
    let changed = false;
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      resolveWork: async () => ({ scopeId: "bot:b", threadId: "t1" }),
      fetch: remoteFetch((url) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse({ ...remoteCatalog,
          desktops: [{ id: "managed-linux", machineId: "local", label: "Desktop", kind: "virtual-display",
            status: "available", managed: "linux-xvnc" }] });
        if (url.endsWith("/artifacts/inspect")) return jsonResponse({ version: {
          sha256: changed ? "0".repeat(64) : sha256, byteLength: bytes.length, modifiedAt: "1790712000000000000",
        } });
        if (url.includes("/artifacts/read?")) return new Response(bytes, { headers: {
          "X-Varin-Computer-Host": "remote-h", "X-Varin-Artifact-Sha256": sha256,
        } });
        return jsonResponse({});
      }),
    });
    await service.list();
    const artifact = await service.registerArtifact("s1", "remote:r1:remote-h:managed-linux", "Downloads/report.pdf");
    expect(artifact).toMatchObject({ sourceHostId: "remote-h", scopeId: "bot:b", threadId: "t1", sha256 });
    expect(await service.listArtifacts("bot:b")).toEqual([artifact]);
    const opened = await service.openArtifact(artifact.id);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    changed = true;
    await expect(service.openArtifact(artifact.id)).rejects.toThrow("version changed");
    await service.dispose();
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
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
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
    const observation = await service.observe({ desktopId: "remote:r1:remote-h:d0", app: "term" });
    expect(observation.id).toBe("remote-obs-9"); // remote freshness id preserved
    const result = await service.act({
      desktopId: "remote:r1:remote-h:d0",
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
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/act")) throw new Error("socket hang up");
        return jsonResponse({});
      }),
    });
    await service.list();
    const result = await service.act({ desktopId: "remote:r1:remote-h:d0", action: { kind: "key", app: "term", key: "enter" } });
    expect(result).toMatchObject({ accepted: false, outcome: "unknown" });
    expect(result.detail).toContain("socket hang up");
  });

  it("a lost response body or changed Host identity never becomes an ordinary rejected action", async () => {
    const replies = [new Response('{', { headers: { 'X-Varin-Computer-Host': 'remote-h' } }),
      new Response(JSON.stringify({ result: { accepted: true } }), { headers: { 'X-Varin-Computer-Host': 'another-host' } })];
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: 'h', platform: 'windows', dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url, init) => {
        if (url.endsWith('/api/computers?local=1')) return jsonResponse(remoteCatalog);
        expect(new Headers(init.headers).get('X-Varin-Computer-Host')).toBe('remote-h');
        return replies.shift()!;
      }),
    });
    await service.list();
    for (let index = 0; index < 2; index++) expect(await service.act({ desktopId: 'remote:r1:remote-h:d0', action: { kind: 'key', app: 'term', key: 'enter' } })).toMatchObject({ outcome: 'unknown', accepted: false });
    await service.dispose();
  });
});

// --- BC7: virtual machine lifecycle -----------------------------------------

import type { VmExec } from "./vm-provider.js";
import { libvirtFixture } from "./libvirt.test-helper.js";

describe("computer service (BC7 virtual machines)", () => {
  const vmProviderConfig = {
    id: "hv1",
    kind: "libvirt" as const,
    uri: "qemu:///system",
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

  it("creates a bootable Debian guest, registers its Host, and exposes the same managed desktop", async () => {
    const driverDir = newDataDir();
    const bundle = join(driverDir, "linux", "guest-bundle-x64");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(driverDir, "linux", "guest-init.sh"), "#!/bin/bash\n");
    writeFileSync(join(driverDir, "linux", "guest-upgrade.sh"), "#!/bin/bash\n");
    const digests: Record<string, string> = {};
    for (const [name, file] of [["runtime", "runtime.tgz"], ["node", "node"], ["bun", "bun"]] as const) {
      const bytes = Buffer.from(name);
      writeFileSync(join(bundle, file), bytes);
      digests[name] = createHash("sha256").update(bytes).digest("hex");
    }
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ schemaVersion: 1, architecture: "x64",
      version: "0.9.21", sourceRevision: "test", digests }));
    const imageBytes = Buffer.alloc(64);
    imageBytes.write("QFI", 0, "ascii"); imageBytes[3] = 0xfb;
    imageBytes.writeBigUInt64BE(2n * 1024n * 1024n * 1024n, 24);
    const imageDigest = createHash("sha512").update(imageBytes).digest();
    const ref = "trixie/20260914-2601/debian-13-generic-amd64-20260914-2601.qcow2";
    let guestHealthy = true;
    let guestHostId = "guest-h";
    const dataDir = newDataDir();
    const fixture = libvirtFixture();
    const exec: VmExec = async (command, args, input) => {
      if (command === "sh") return { code: 0, stdout: "", stderr: "" };
      if (command === "genisoimage") {
        writeFileSync(args[args.indexOf("-output") + 1]!, "seed fixture");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "virsh" && args[2] === "domifaddr") return { code: 0,
        stdout: " Name  MAC  Protocol  Address\nvnet0  52:54:00:aa:bb:cc  ipv4  192.168.122.51/24\n", stderr: "" };
      return fixture.exec(command, args, input);
    };
    let connections: Array<{ id: string; label: string; apiUrl: string; clientToken: string; expectedHostId: string }> = [];
    const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: {
      "Content-Type": "application/json", "X-Varin-Computer-Host": "guest-h",
    } });
    const service = createComputerService({ client: fakeKernel().client as never, hostId: "coordinator",
      platform: "linux", dataDir, driverDir, appVersion: "0.9.21", vmExec: exec,
      createDriver: () => makeDriver(async () => okResponse()), vmProviders: async () => [vmProviderConfig],
      vmGuestFetch: (async (url: string) => {
        if (url.endsWith(".json")) return Response.json({ items: [{ kind: "Upload", data: { ref },
          metadata: { annotations: { "cloud.debian.org/digest": `sha512:${imageDigest.toString("base64")}` } } }] });
        if (url.endsWith(".qcow2")) return new Response(imageBytes);
        if (url.endsWith("/health")) return guestHealthy
          ? Response.json({ status: "ok", varinVersion: "0.9.21", serverId: guestHostId })
          : Response.json({ status: "ok", varinVersion: "0.9.20", serverId: guestHostId });
        throw new Error(`Unexpected guest fetch: ${url}`);
      }) as typeof fetch,
      registerVmGuest: async (input) => { connections = [{ id: input.connectionId, label: input.label,
        apiUrl: input.apiUrl, clientToken: "token", expectedHostId: input.hostId }]; },
      removeVmGuest: async () => { connections = []; },
      remoteHosts: async () => connections,
      fetch: (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/computers?local=1")) return reply({ machines: [{ id: "local", provider: "local",
          platform: "linux", coordinatorHostId: "guest-h", name: "guest", status: "active", createdAt: "t", updatedAt: "t" }],
          desktops: [{ id: "managed-linux", machineId: "local", label: "Persistent Linux desktop", kind: "virtual-display",
            status: "available", managed: "linux-xvnc", media: { kind: "vnc", width: 1280, height: 800 } }] });
        if (url.endsWith("/probe")) return reply({ desktop: { id: "managed-linux", machineId: "local",
          status: "available", managed: "linux-xvnc", media: { kind: "vnc", width: 1280, height: 800 },
          capabilities: { platform: "linux", driver: "linux-atspi", status: "ready" } } });
        return reply({});
      }) as typeof fetch,
    });
    const created = await service.createVm({ providerId: "hv1", name: "office", managed: true });
    expect(created.machine.vm?.volumePaths).toEqual([
      `varin-${created.machine.vm!.domainUuid}.qcow2`,
      `varin-${created.machine.vm!.domainUuid}-base.qcow2`,
      `varin-${created.machine.vm!.domainUuid}-seed.iso`,
    ]);
    await service.reconcileVmGuests();
    const vm = (await service.listVms())[0]!;
    expect(vm.binding.guest?.state).toBe("ready");
    expect(connections[0]?.id).toBe(`vm:${vm.binding.domainUuid}`);
    const desktop = (await service.list()).desktops.find((item) => item.remote?.connectionId === connections[0]?.id);
    expect(desktop?.media?.kind).toBe("vnc");
    guestHealthy = false;
    await service.reconcileVmGuests();
    expect((await service.listVms())[0]?.binding.guest?.state).toBe("preparing");
    await service.vmAction({ machineId: vm.machineId, action: "shutdown" });
    await service.vmAction({ machineId: vm.machineId, action: "upgrade" });
    expect((await service.listVms())[0]?.binding.guest?.runtimeSha256).toBe(digests.runtime);
    guestHealthy = true;
    await service.vmAction({ machineId: vm.machineId, action: "start" });
    await service.reconcileVmGuests();
    expect((await service.listVms())[0]?.binding.guest?.state).toBe("ready");
    guestHostId = "replacement-host";
    await service.reconcileVmGuests();
    expect((await service.listVms())[0]?.binding.guest?.state).toBe("failed");
    await service.deleteVm(vm.machineId, false);
    expect(existsSync(join(dataDir, "computer-vms", `${vm.binding.domainUuid}.json`))).toBe(true);
    await service.dispose();
  });

  it("create records provider identity, domain UUID, volumes, and the step journal", async () => {
    const { exec, calls, domains } = libvirtFixture();
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
      domainUuid: expect.any(String),
      volumePaths: [`varin-${machine.vm!.domainUuid}.qcow2`],
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
    expect(JSON.parse(stored!.payloadJson).vm.domainUuid).toBe(machine.vm!.domainUuid);
    expect(domains.get(machine.vm!.domainUuid)?.name).toBe("devbox");
    expect(calls.some(({ args }) => args[0] === "define")).toBe(true);
  });

  it("a retried create adopts the existing domain — no duplicate volume/define", async () => {
    const { exec, calls } = libvirtFixture();
    const { service } = makeVmService(exec);
    const first = await service.createVm({ providerId: "hv1", name: "devbox" });
    const { machine, created } = await service.createVm({ providerId: "hv1", name: "devbox" });
    expect(created).toBe(false);
    expect(machine.vm!.domainUuid).toBe(first.machine.vm!.domainUuid);
    expect(calls.filter(({ args }) => args[0] === "vol-create-as")).toHaveLength(1);
    expect(calls.filter(({ args }) => args[0] === "define")).toHaveLength(1);
  });

  it("start/shutdown key on the recorded domain UUID and sync status", async () => {
    const { exec, calls } = libvirtFixture();
    const { service } = makeVmService(exec);
    const { machine } = await service.createVm({ providerId: "hv1", name: "devbox" });
    const started = await service.vmAction({ machineId: machine.id, action: "start" });
    expect(started.state).toBe("running");
    expect(calls.some(({ args }) => args[0] === "start" && args[1] === machine.vm!.domainUuid)).toBe(true);
    const stopped = await service.vmAction({ machineId: machine.id, action: "shutdown" });
    expect(stopped.state).toBe("shutoff");
    expect(calls.some(({ args }) => args[0] === "shutdown" && args[1] === machine.vm!.domainUuid)).toBe(true);
  });

  it("delete archives the record and only removes disks when asked", async () => {
    const { exec, volumes } = libvirtFixture();
    const { service } = makeVmService(exec);
    const { machine } = await service.createVm({ providerId: "hv1", name: "devbox" });

    // Default delete: persistent disk survives.
    await service.deleteVm(machine.id, false);
    expect(volumes.has(machine.vm!.volumePaths[0]!)).toBe(true);

    const vms = await service.listVms();
    expect(vms).toEqual([]); // archived machines leave the VM list
  });

  it("a failed create persists the journal on an unavailable machine record", async () => {
    const { exec, faults, volumes } = libvirtFixture();
    faults.set("define", "before");
    const { service } = makeVmService(exec);
    await expect(service.createVm({ providerId: "hv1", name: "broken" })).rejects.toThrow(/define/);
    const catalog = await service.list();
    const machine = catalog.machines.find((m) => m.name === "broken");
    expect(machine).toBeDefined();
    expect(machine!.status).toBe("unavailable");
    expect(machine!.vm!.steps.map((s) => `${s.step}:${s.status}`)).toContain("define:failed");
    expect(machine!.vm!.volumePaths).toHaveLength(1);
    expect(volumes.has(machine!.vm!.volumePaths[0]!)).toBe(true);
    faults.delete("define");
    const retried = await service.createVm({ providerId: "hv1", name: "broken" });
    expect(retried.machine.vm!.domainUuid).toBe(machine!.vm!.domainUuid);
  });
});

describe("computer service work association (BC8)", () => {
  it("replays a returned-control event after delivery failure without losing its identity", async () => {
    const kernel = fakeKernel();
    const delivered: string[] = [];
    const options = { client: kernel.client as never, hostId: "h", platform: "windows" as const, dataDir: newDataDir(),
      createDriver: () => makeDriver(async (op) => op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() }) : okResponse()),
      resolveWork: async () => ({ scopeId: "bot:b", threadId: "t1" }) };
    const first = createComputerService({ ...options, onHandback: async (event) => { delivered.push(event.id); throw new Error("Thread unavailable"); } });
    await first.ensureLocal();
    await first.observe({ desktopId: "local-console", app: "notepad", sessionId: "s1" });
    const unsubscribe = await first.subscribeFrames("local-console", "viewer", () => {}, { frames: false });
    await first.takeover({ desktopId: "local-console", holderId: "viewer" });
    await first.handback({ desktopId: "local-console", holderId: "viewer" });
    await first.reconcileHandbacks().catch(() => undefined);
    unsubscribe();
    await first.dispose();
    const resumed = createComputerService({ ...options, onHandback: async (event) => { delivered.push(event.id); } });
    await resumed.reconcileHandbacks();
    await resumed.reconcileHandbacks();
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    expect(new Set(delivered).size).toBe(1);
    const record = kernel.records.get("__varin_computers__:computer.desktop:local-console");
    expect(JSON.parse(record!.payloadJson).handbackEvents).toEqual([]);
    await resumed.dispose();
  });

  it("keeps every actual Thread association across later work, probes, and Host restart", async () => {
    const kernel = fakeKernel();
    const options = { client: kernel.client as never, hostId: "h", platform: "windows" as const, dataDir: newDataDir(),
      createDriver: () => makeDriver(async (op) => op.tool === "get_app_state" ? okResponse({ snapshot: appSnapshot() })
        : op.tool === "capabilities" ? okResponse({ capabilities: { platform: "windows", driver: "windows-uia", status: "ready" } }) : okResponse()),
      resolveWork: async (sessionId: string) => ({ scopeId: "bot:b", threadId: sessionId === "s2" ? "t2" : "t1" }) };
    const service = createComputerService(options);
    await service.ensureLocal();
    for (const sessionId of ["s1", "s2", "s3"]) {
      await service.observe({ desktopId: "local-console", app: "notepad", includeScreenshot: false, sessionId });
    }
    await service.probe("local-console");
    const association = (await service.workDesktops("bot:b"))[0]?.work;
    expect(association).toHaveLength(2);
    expect(association?.find((item) => item.threadId === "t1")?.sessionId).toBe("s3");
    expect(association?.find((item) => item.threadId === "t2")?.sessionId).toBe("s2");
    await service.dispose();
    const reopened = createComputerService(options);
    expect((await reopened.workDesktops("bot:b"))[0]?.work).toEqual(association);
    await reopened.dispose();
  });

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

// --- EE: cross-environment open + one-shot file write -----------------------

describe("computer service (EE open + file write)", () => {
  it("open dispatches the driver op and returns the launched pid", async () => {
    const driver = makeDriver(async (op) => op.tool === "open" ? okResponse({ pid: 4711 }) : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const result = await service.open({ desktopId: "local-console", url: "http://localhost:3000/" });
    expect(result).toEqual({ accepted: true, pid: 4711 });
    expect(driver.calls).toContainEqual(expect.objectContaining({ tool: "open", url: "http://localhost:3000/" }));
    await service.dispose();
  });

  it("open requires exactly one target and refuses script-injected schemes", async () => {
    const { service } = makeService();
    await service.ensureLocal();
    await expect(service.open({ desktopId: "local-console" })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.open({ desktopId: "local-console", url: "http://x", path: "c:\f" })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.open({ desktopId: "local-console", url: "javascript:alert(1)" })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.open({ desktopId: "local-console", url: "not a url" })).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await service.dispose();
  });

  it("open is rejected while a human viewer owns the desktop", async () => {
    const driver = makeDriver(async () => okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const unsubscribe = await service.subscribeFrames("local-console", "human", () => {}, { frames: false });
    await service.takeover({ desktopId: "local-console", holderId: "human" });
    await expect(service.open({ desktopId: "local-console", url: "http://localhost/" })).rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(driver.calls.filter((op) => op.tool === "open")).toEqual([]);
    unsubscribe();
    await service.dispose();
  });

  const remoteHost = { id: "r1", label: "Office PC", apiUrl: "http://10.0.0.5:8765", clientToken: "tok-1" };
  const remoteCatalog = {
    machines: [{ id: "local", name: "Office PC", provider: "local", platform: "linux", coordinatorHostId: "remote-h", status: "active", createdAt: "t", updatedAt: "t" }],
    desktops: [{ id: "d0", machineId: "local", label: "Console", kind: "console", status: "available" }],
    defaultDesktopId: "d0",
  };
  const remoteFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (
    (async (input: unknown, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch
  );
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Varin-Computer-Host": "remote-h" },
  });

  it("remote open forwards the target verbatim and reports unknown on transport loss", async () => {
    const seen: Record<string, unknown> = {};
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url, init) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/open")) { seen.body = JSON.parse(String(init.body)); return jsonResponse({ result: { accepted: true, pid: 99 } }); }
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    });
    await service.list();
    const result = await service.open({ desktopId: "remote:r1:remote-h:d0", url: "http://localhost:8080/app" });
    expect(result).toEqual({ accepted: true, pid: 99 });
    // localhost must reach the remote Host untouched — rewriting it here
    // would silently point at the coordinator's own loopback.
    expect(seen.body).toEqual({ url: "http://localhost:8080/app" });
    await service.dispose();
  });

  it("remote open transport failure reports outcome unknown rather than replaying", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/open")) throw new Error("socket hang up");
        return jsonResponse({});
      }),
    });
    await service.list();
    const result = await service.open({ desktopId: "remote:r1:remote-h:d0", command: "code" });
    expect(result).toMatchObject({ accepted: false, outcome: "unknown" });
    await service.dispose();
  });

  it("fileWrite forwards bytes to the remote Host and returns its stored revision", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url, init) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/artifacts/write")) {
          const body = JSON.parse(String(init.body)) as { relativePath: string; contentBase64: string };
          const bytes = Buffer.from(body.contentBase64, "base64");
          return jsonResponse({ version: { sha256: "a".repeat(64), byteLength: bytes.length, modifiedAt: "1790712000000000000" } });
        }
        return jsonResponse({});
      }),
    });
    await service.list();
    const content = Buffer.from("payload");
    const result = await service.fileWrite({ desktopId: "remote:r1:remote-h:d0", relativePath: "Downloads/in.csv", contentBase64: content.toString("base64") });
    expect(result.version.byteLength).toBe(content.length);
    await service.dispose();
  });

  it("fileWrite against a non-managed local desktop is unavailable, not faked", async () => {
    const { service } = makeService();
    await service.ensureLocal();
    await expect(service.fileWrite({ desktopId: "local-console", relativePath: "x.txt", contentBase64: "eA==" }))
      .rejects.toMatchObject({ harnessCode: "unavailable" });
    await expect(service.fileWrite({ desktopId: "local-console", relativePath: "..\\evil", contentBase64: "eA==" }))
      .rejects.toMatchObject({ harnessCode: "invalid-params" });
    await service.dispose();
  });
});

describe("software install (EE §6.2)", () => {
  const remoteHost = { id: "r1", label: "Office PC", apiUrl: "http://10.0.0.5:8765", clientToken: "tok-1" };
  const remoteCatalog = {
    machines: [{ id: "local", name: "Office PC", provider: "local", platform: "linux", coordinatorHostId: "remote-h", status: "active", createdAt: "t", updatedAt: "t" }],
    desktops: [{ id: "d0", machineId: "local", label: "Console", kind: "console", status: "available", managed: "linux-xvnc" }],
    defaultDesktopId: "d0",
  };
  const remoteFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (
    (async (input: unknown, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch
  );
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Varin-Computer-Host": "remote-h" },
  });
  const seedManagedDesktop = (records: Map<string, StoredRecord>) => {
    records.set(`__varin_computers__:computer.desktop:managed-linux`, {
      recordId: "computer.desktop:managed-linux",
      recordType: "computer.desktop",
      state: "available",
      payloadJson: JSON.stringify({ id: "managed-linux", machineId: "m-1", label: "Managed Linux", managed: "linux-xvnc" }),
      recordRevision: 1, createdAt: 0, updatedAt: 0,
    });
  };

  it("installs a recipe group on the managed desktop and records per-component state", async () => {
    const kernel = fakeKernel();
    seedManagedDesktop(kernel.records);
    const calls: string[][] = [];
    const service = createComputerService({
      client: kernel.client as never, hostId: "h", platform: "linux", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      vmExec: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: JSON.stringify({ ok: true, results: [{ id: "dev", state: "installed", packages: ["git", "jq"] }] }), stderr: "" };
      },
    });
    const result = await service.installSoftware({ desktopId: "managed-linux", groups: ["dev"] });
    expect(result.results).toEqual([{ id: "dev", state: "installed", packages: ["git", "jq"] }]);
    const record = kernel.records.get("__varin_computers__:computer.desktop:managed-linux")!;
    const software = (JSON.parse(record.payloadJson) as { software: Record<string, { state: string }> }).software;
    expect(software.dev?.state).toBe("installed");
    await service.dispose();
  });

  it("a failed component stays visible on the record — not collapsed into success", async () => {
    const kernel = fakeKernel();
    seedManagedDesktop(kernel.records);
    const service = createComputerService({
      client: kernel.client as never, hostId: "h", platform: "linux", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()),
      vmExec: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, results: [{ id: "docs", state: "failed", detail: "E: package not found" }] }), stderr: "" }),
    });
    const result = await service.installSoftware({ desktopId: "managed-linux", groups: ["docs"] });
    expect(result.results[0]?.state).toBe("failed");
    const record = kernel.records.get("__varin_computers__:computer.desktop:managed-linux")!;
    const software = (JSON.parse(record.payloadJson) as { software: Record<string, { state: string; detail?: string }> }).software;
    expect(software.docs?.state).toBe("failed");
    expect(software.docs?.detail).toContain("package not found");
    await service.dispose();
  });

  it("forwards install requests to the remote Host that owns the desktop", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url, init) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/software")) {
          const body = JSON.parse(String(init.body)) as { groups?: string[] };
          expect(body.groups).toEqual(["dev"]);
          return jsonResponse({ results: [{ id: "dev", state: "installed" }] });
        }
        return jsonResponse({});
      }),
    });
    await service.list();
    const result = await service.installSoftware({ desktopId: "remote:r1:remote-h:d0", groups: ["dev"] });
    expect(result.results[0]?.state).toBe("installed");
    await service.dispose();
  });

  it("refuses unmanaged targets and empty requests instead of pretending", async () => {
    const { service } = makeService();
    await service.ensureLocal();
    await expect(service.installSoftware({ desktopId: "local-console", groups: ["dev"] }))
      .rejects.toMatchObject({ harnessCode: "unavailable" });
    await expect(service.installSoftware({ desktopId: "managed-linux" }))
      .rejects.toMatchObject({ harnessCode: "invalid-params" });
    await service.dispose();
  });
});

describe("browser bridge (EE §7.2)", () => {
  const remoteHost = { id: "r1", label: "Office PC", apiUrl: "http://10.0.0.5:8765", clientToken: "tok-1" };
  const remoteCatalog = {
    machines: [{ id: "local", name: "Office PC", provider: "local", platform: "linux", coordinatorHostId: "remote-h", status: "active", createdAt: "t", updatedAt: "t" }],
    desktops: [{ id: "d0", machineId: "local", label: "Console", kind: "console", status: "available", managed: "linux-xvnc" }],
    defaultDesktopId: "d0",
  };
  const remoteFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (
    (async (input: unknown, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch
  );
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Varin-Computer-Host": "remote-h" },
  });
  it("dispatches browser ops to the desktop's driver on the same lane", async () => {
    const driver = makeDriver(async (op) => {
      if (op.tool === "browser") return okResponse({ status: { running: true, browser: "Chromium/1" } });
      return okResponse();
    });
    const { service } = makeService(driver);
    await service.ensureLocal();
    const result = await service.browser({ desktopId: "local-console", op: "status" });
    expect(result.ok).toBe(true);
    expect(result.status?.running).toBe(true);
    expect(driver.calls.at(-1)).toMatchObject({ tool: "browser", op: "status" });
    await service.dispose();
  });

  it("write ops hold the human-control gate while reads stay observable", async () => {
    const driver = makeDriver(async (op) => op.tool === "browser" ? okResponse({ tabs: [] }) : okResponse());
    const { service } = makeService(driver);
    await service.ensureLocal();
    const unsubscribe = await service.subscribeFrames("local-console", "human", () => {}, { frames: false });
    await service.takeover({ desktopId: "local-console", holderId: "human" });
    await expect(service.browser({ desktopId: "local-console", op: "act", act: { kind: "navigate", url: "https://x/" } }))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    // A human-owned desktop can still be observed — reads are not input.
    const status = await service.browser({ desktopId: "local-console", op: "tabs" });
    expect(status.ok).toBe(true);
    unsubscribe(); await service.dispose();
  });

  it("forwards browser ops to the remote Host and reports unknown on transport loss", async () => {
    const service = createComputerService({
      client: fakeKernel().client as never, hostId: "h", platform: "windows", dataDir: newDataDir(),
      createDriver: () => makeDriver(async () => okResponse()), remoteHosts: async () => [remoteHost],
      fetch: remoteFetch((url, init) => {
        if (url.endsWith("/api/computers?local=1")) return jsonResponse(remoteCatalog);
        if (url.endsWith("/browser") && init.method === "POST") {
          const body = JSON.parse(String(init.body)) as { op: string };
          if (body.op === "act") throw new TypeError("fetch failed");
          return jsonResponse({ ok: true, tabs: [{ id: "t1", title: "Doc", url: "https://d/" }] });
        }
        return jsonResponse({});
      }),
    });
    await service.list();
    const tabs = await service.browser({ desktopId: "remote:r1:remote-h:d0", op: "tabs" });
    expect(tabs.tabs?.[0]?.id).toBe("t1");
    const lost = await service.browser({ desktopId: "remote:r1:remote-h:d0", op: "act", act: { kind: "evaluate", expression: "1" } });
    expect(lost.ok).toBe(false);
    expect(lost.outcome).toBe("unknown");
    await service.dispose();
  });
});
