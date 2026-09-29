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
  const computers = {
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
    expect(computers.probe).toHaveBeenCalledWith("local-console");
  });

  it("a probe failure maps to an HTTP error, not a fake success", async () => {
    const { app, computers } = fixture();
    computers.probe.mockRejectedValue(new HarnessServiceError("unavailable", "no desktop session"));
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
