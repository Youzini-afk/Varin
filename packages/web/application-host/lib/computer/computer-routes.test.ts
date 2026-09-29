import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerComputerRoutes } from "./computer-routes.js";
import { HarnessServiceError } from "../harness/service-error.js";
import type { ComputerDesktop, ComputerMachine } from "@varin/protocol";

const machine: ComputerMachine = {
  id: "local",
  name: "This PC",
  provider: "local",
  platform: "windows",
  coordinatorHostId: "host-1",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const desktop: ComputerDesktop = {
  id: "local-console",
  machineId: "local",
  label: "Console session",
  kind: "console",
  status: "available",
};

const fixture = () => {
  const computers: Record<string, ReturnType<typeof vi.fn>> = {
    list: vi.fn(async () => ({ machines: [machine], desktops: [desktop] })),
    probe: vi.fn(async () => ({ ...desktop, capabilities: { platform: "windows", driver: "windows-uia", observeTree: true, screenshot: true, elementAction: true, coordinateInput: true, textInput: true, drag: true, status: "ready" as const } })),
    defaultDesktop: vi.fn(async () => "local-console"),
    setDefaultDesktop: vi.fn(async () => undefined),
  };
  const app = express();
  app.use(express.json());
  registerComputerRoutes(app, { computers: computers as never });
  return { app, computers };
};

describe("computer routes (BC4)", () => {
  it("GET /api/computers returns the catalog with the persisted default", async () => {
    const { app, computers } = fixture();
    const response = await request(app).get("/api/computers");
    expect(response.status).toBe(200);
    expect(response.body.machines[0].id).toBe("local");
    expect(response.body.desktops[0].id).toBe("local-console");
    expect(response.body.defaultDesktopId).toBe("local-console");
    expect(computers.defaultDesktop).toHaveBeenCalled();
  });

  it("POST probe returns the refreshed desktop with capabilities", async () => {
    const { app, computers } = fixture();
    const response = await request(app).post("/api/computers/desktops/local-console/probe");
    expect(response.status).toBe(200);
    expect(response.body.desktop.capabilities.driver).toBe("windows-uia");
    expect(computers.probe!).toHaveBeenCalledWith("local-console");
  });

  it("a probe failure maps to an HTTP error, not a fake success", async () => {
    const { app, computers } = fixture();
    computers.probe!.mockRejectedValue(new HarnessServiceError("unavailable", "no desktop session"));
    const response = await request(app).post("/api/computers/desktops/local-console/probe");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("unavailable");
  });

  it("setting the default target probes the desktop first and persists the id", async () => {
    const { app, computers } = fixture();
    const response = await request(app)
      .post("/api/computers/default-target")
      .send({ desktopId: "local-console" });
    expect(response.status).toBe(200);
    expect(computers.probe).toHaveBeenCalledWith("local-console");
    expect(computers.setDefaultDesktop).toHaveBeenCalledWith("local-console");
  });

  it("default-target rejects a malformed body", async () => {
    const { app } = fixture();
    const response = await request(app)
      .post("/api/computers/default-target")
      .send({ desktopId: 42 });
    expect(response.status).toBe(400);
  });

  it("default-target clears with null without probing", async () => {
    const { app, computers } = fixture();
    const response = await request(app)
      .post("/api/computers/default-target")
      .send({ desktopId: null });
    expect(response.status).toBe(200);
    expect(computers.probe).not.toHaveBeenCalled();
    expect(computers.setDefaultDesktop).toHaveBeenCalledWith(null);
  });
});

describe("computer routes (BC5 control + view)", () => {
  const fixture5 = () => {
    const { app, computers } = fixture();
    const control = {
      desktopId: "local-console",
      owner: "agent" as const,
      reachable: true,
      since: "2026-01-01T00:00:00Z",
    };
    Object.assign(computers, {
      control: vi.fn(async () => control),
      takeover: vi.fn(async (params: { desktopId: string; holderId?: string }) => ({
        control: { ...control, owner: "human" as const, holderId: params.holderId },
        cancelled: 0,
        released: true,
      })),
      handback: vi.fn(async () => ({ control, requiresObservation: true as const })),
      input: vi.fn(async () => ({ accepted: true })),
      subscribeFrames: vi.fn(async () => () => undefined),
    });
    return { app, computers };
  };

  it("GET control returns the owner record", async () => {
    const { app, computers } = fixture5();
    const response = await request(app).get("/api/computers/desktops/local-console/control");
    expect(response.status).toBe(200);
    expect(response.body.control.owner).toBe("agent");
    expect(computers.control).toHaveBeenCalledWith("local-console");
  });

  it("POST takeover passes the holder id and returns the transfer result", async () => {
    const { app, computers } = fixture5();
    const response = await request(app)
      .post("/api/computers/desktops/local-console/takeover")
      .send({ holderId: "viewer-9" });
    expect(response.status).toBe(200);
    expect(response.body.control.owner).toBe("human");
    expect(response.body.control.holderId).toBe("viewer-9");
    expect(computers.takeover).toHaveBeenCalledWith({ desktopId: "local-console", holderId: "viewer-9" });
  });

  it("input while the agent owns the desktop maps forbidden to 409", async () => {
    const { app, computers } = fixture5();
    computers.input!.mockRejectedValue(
      new HarnessServiceError("forbidden", "Desktop is not under human control"),
    );
    const response = await request(app)
      .post("/api/computers/desktops/local-console/input")
      .send({ holderId: "v1", input: { kind: "click", x: 1, y: 2 } });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("forbidden");
  });

  it("handback returns the agent-control record", async () => {
    const { app } = fixture5();
    const response = await request(app)
      .post("/api/computers/desktops/local-console/handback")
      .send({ holderId: "v1" });
    expect(response.status).toBe(200);
    expect(response.body.control.owner).toBe("agent");
    expect(response.body.requiresObservation).toBe(true);
  });
});

describe("computer routes (BC7 virtual machines)", () => {
  const vmDescriptor = {
    machineId: "vm:hv1:devbox",
    name: "devbox",
    binding: {
      providerId: "hv1",
      kind: "libvirt" as const,
      uri: "qemu:///system",
      domainUuid: "1111aaaa-2222-3333-4444-555566667777",
      volumePaths: ["devbox.qcow2"],
      steps: [],
    },
    state: "running" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const vmMachine: ComputerMachine = {
    id: "vm:hv1:devbox",
    name: "devbox",
    provider: "virtual",
    platform: "linux",
    coordinatorHostId: "host-1",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    vm: vmDescriptor.binding,
  };

  const fixture7 = () => {
    const { app, computers } = fixture();
    Object.assign(computers, {
      listVms: vi.fn(async () => [vmDescriptor]),
      createVm: vi.fn(async () => ({ machine: vmMachine, created: true })),
      vmAction: vi.fn(async () => vmDescriptor),
      deleteVm: vi.fn(async () => undefined),
    });
    return { app, computers };
  };

  it("GET /api/computers/vms returns live descriptors", async () => {
    const { app, computers } = fixture7();
    const response = await request(app).get("/api/computers/vms");
    expect(response.status).toBe(200);
    expect(response.body.vms[0].binding.domainUuid).toBe("1111aaaa-2222-3333-4444-555566667777");
    expect(computers.listVms).toHaveBeenCalled();
  });

  it("POST create returns 201 for a new domain and forwards the spec", async () => {
    const { app, computers } = fixture7();
    const response = await request(app)
      .post("/api/computers/vms")
      .send({ providerId: "hv1", name: "devbox", memoryMiB: 4096, diskGiB: 40 });
    expect(response.status).toBe(201);
    expect(computers.createVm).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "hv1",
      name: "devbox",
      memoryMiB: 4096,
      diskGiB: 40,
    }));
  });

  it("an adopted domain returns 200, not 201", async () => {
    const { app, computers } = fixture7();
    computers.createVm!.mockResolvedValue({ machine: vmMachine, created: false });
    const response = await request(app)
      .post("/api/computers/vms")
      .send({ providerId: "hv1", name: "devbox" });
    expect(response.status).toBe(200);
  });

  it("lifecycle actions route by machine id; delete forwards deleteDisks", async () => {
    const { app, computers } = fixture7();
    const response = await request(app).post("/api/computers/vms/vm:hv1:devbox/start");
    expect(response.status).toBe(200);
    expect(computers.vmAction).toHaveBeenCalledWith({ machineId: "vm:hv1:devbox", action: "start" });

    const del = await request(app)
      .post("/api/computers/vms/vm:hv1:devbox/delete")
      .send({ deleteDisks: true });
    expect(del.status).toBe(200);
    expect(computers.deleteVm).toHaveBeenCalledWith("vm:hv1:devbox", true);
  });

  it("an unknown action is a 400, not a provider call", async () => {
    const { app, computers } = fixture7();
    const response = await request(app).post("/api/computers/vms/vm:hv1:devbox/explode");
    expect(response.status).toBe(400);
    expect(computers.vmAction).not.toHaveBeenCalled();
  });
});
