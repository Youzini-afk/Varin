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
