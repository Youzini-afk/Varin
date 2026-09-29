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
        : error.harnessCode === "forbidden" || error.harnessCode === "denied" ? 409
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

  // --- BC5: control ownership + desktop view --------------------------------

  /** Who currently owns input on this desktop (agent or a human viewer). */
  app.get("/api/computers/desktops/:desktopId/control", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const control = await computers.control(String(request.params.desktopId ?? ""));
      response.json({ control });
    } catch (error) {
      sendError(response, error, "Unable to read desktop control");
    }
  });

  /**
   * Take over a desktop as a human viewer. The Host drops queued automation,
   * interrupts the in-flight op, releases held input, and only then confirms
   * the transfer — the response is the first moment a viewer may send input.
   */
  app.post("/api/computers/desktops/:desktopId/takeover", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const holderId = typeof request.body?.holderId === "string" ? request.body.holderId : undefined;
      const result = await computers.takeover({
        desktopId: String(request.params.desktopId ?? ""),
        ...(holderId ? { holderId } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to take over the desktop");
    }
  });

  /** Return control to the agent; stale observations are invalidated. */
  app.post("/api/computers/desktops/:desktopId/handback", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const holderId = typeof request.body?.holderId === "string" ? request.body.holderId : undefined;
      const result = await computers.handback({
        desktopId: String(request.params.desktopId ?? ""),
        ...(holderId ? { holderId } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to return desktop control");
    }
  });

  /** Human input — only while `control.owner === "human"` (BC5.C). */
  app.post("/api/computers/desktops/:desktopId/input", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const holderId = typeof request.body?.holderId === "string" ? request.body.holderId : undefined;
      const result = await computers.input({
        desktopId: String(request.params.desktopId ?? ""),
        ...(holderId ? { holderId } : {}),
        input: request.body?.input,
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to deliver desktop input");
    }
  });

  /**
   * Frame + control subscription for a desktop view (BC5.B). Each subscriber
   * is independent — closing the page ends only this SSE connection, never
   * the task or the desktop. The holder's disconnect marks its control
   * pending-recovery instead of silently handing back.
   */
  app.get("/api/computers/desktops/:desktopId/stream", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const desktopId = String(request.params.desktopId ?? "");
    const viewerId = typeof request.query.viewer === "string" && request.query.viewer
      ? request.query.viewer
      : `viewer-${Math.random().toString(36).slice(2)}`;
    // SSE headers must be committed before subscribing — the first control
    // event is delivered synchronously on subscribe.
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await computers.subscribeFrames(desktopId, viewerId, (event) => {
        if (response.writableEnded) return;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (error) {
      response.write(`data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "subscribe failed" })}\n\n`);
      response.end();
      return;
    }
    request.on("close", () => {
      unsubscribe?.();
    });
  });
}
