import type { Express, Request, RequestHandler, Response } from "express";
import { HarnessServiceError } from "../harness/service-error.js";
import type { ComputerService } from "./computer-service.js";

/**
 * Computer catalog routes (BC4): environment selection surfaces read machines
 * and desktops here; action/observe traffic stays on the harness bridge.
 */
export interface ComputerRoutesOptions {
  computers: ComputerService;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();

const sendError = (response: Response, error: unknown, fallback: string): void => {
  if (error instanceof HarnessServiceError) {
    const status = error.harnessCode === "invalid-params" ? 400
      : error.harnessCode === "not-found" ? 404
        : 500;
    response.status(status).json({ code: error.harnessCode, error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : fallback });
};

export function registerComputerRoutes(app: Express, { computers, requireAuth = noAuth }: ComputerRoutesOptions): void {
  app.get("/api/computers", requireAuth, async (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const catalog = await computers.list();
      response.json({
        ...catalog,
        defaultDesktopId: await computers.defaultDesktop(),
      });
    } catch (error) {
      sendError(response, error, "Unable to list computers");
    }
  });

  /** Re-probe a desktop's driver and persist the real capability table. */
  app.post("/api/computers/desktops/:desktopId/probe", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const desktop = await computers.probe(String(request.params.desktopId ?? ""));
      response.json({ desktop });
    } catch (error) {
      sendError(response, error, "Unable to probe desktop");
    }
  });

  /** Persist the caller's default execution target (null clears it). */
  app.post("/api/computers/default-target", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const value = request.body?.desktopId;
      if (value !== null && value !== undefined && typeof value !== "string") {
        throw new HarnessServiceError("invalid-params", "desktopId must be a string or null");
      }
      const desktopId = typeof value === "string" && value.trim() ? value.trim() : null;
      if (desktopId) {
        // Selecting a target proves the desktop exists and reports real state.
        await computers.probe(desktopId);
      }
      await computers.setDefaultDesktop(desktopId);
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error, "Unable to set default computer target");
    }
  });
}
