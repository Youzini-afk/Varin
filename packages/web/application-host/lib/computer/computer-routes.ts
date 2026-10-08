import type { Express, Request, RequestHandler, Response } from "express";
import { HarnessServiceError } from "../harness/service-error.js";
import type { ComputerService } from "./computer-service.js";
import type { ComputerActor, ComputerAccess } from '@varin/protocol';

/**
 * Computer catalog routes (BC4): environment selection surfaces read machines
 * and desktops here; action/observe traffic stays on the harness bridge.
 */
export interface ComputerRoutesOptions {
  computers: ComputerService;
  requireAuth?: RequestHandler;
  hostId?: string;
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

export function registerComputerRoutes(app: Express, { computers, requireAuth = noAuth, hostId }: ComputerRoutesOptions): void {
  if (hostId) app.use('/api/computers', requireAuth, (request, response, next) => {
    response.setHeader('X-Varin-Computer-Host', hostId);
    const expected = request.get('X-Varin-Computer-Host');
    if (expected && expected !== hostId) {
      response.status(409).json({ code: 'forbidden', error: 'This connection reaches a different computer Host' });
      return;
    }
    next();
  });
  app.get("/api/computers", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const catalog = await computers.list(request.query.local === "1" ? { localOnly: true } : undefined);
      response.json({
        ...catalog,
        defaultDesktopId: await computers.defaultDesktop(),
      });
    } catch (error) {
      sendError(response, error, "Unable to list computers");
    }
  });

  // Pure in-memory projection: opening a chat must not probe or capture a desktop.
  app.get("/api/computers/activity", requireAuth, (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ activities: computers.activities(typeof request.query.sessionId === "string" ? request.query.sessionId : undefined) });
  });

  app.get('/api/computers/automation', requireAuth, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const sessionId = String(request.query.sessionId ?? '');
      const state = await computers.automation.snapshot(sessionId);
      const sessions = new Set([sessionId, state.rootSessionId, ...state.leases.map(lease => lease.actor.sessionId), ...state.requests.map(item => item.actor.sessionId)]);
      response.json({ state, activities: computers.activities().filter(entry => entry.activity.sessionId && sessions.has(entry.activity.sessionId)) });
    }
    catch (error) { sendError(response, error, 'Unable to read Computer Use state'); }
  });
  app.post('/api/computers/automation/stop', requireAuth, async (request, response) => {
    try { response.json({ state: await computers.automation.stop(String(request.body?.sessionId ?? '')) }); }
    catch (error) { sendError(response, error, 'Unable to confirm Computer Use stop'); }
  });
  app.post('/api/computers/desktops/:desktopId/assignment', requireAuth, async (request, response) => {
    try {
      const body = request.body;
      const actor = body?.actor;
      if (typeof body?.origin !== 'string' || !body.origin.trim() || typeof body.assignmentId !== 'string' || !body.assignmentId.trim() || !actor || typeof actor.readOnly !== 'boolean'
        || ['sessionId', 'runId', 'threadId', 'scopeId', 'rootSessionId', 'rootRunId', 'label'].some(field => typeof actor[field] !== 'string' || !actor[field].trim())) {
        throw new HarnessServiceError('invalid-params', 'A trusted Host execution identity is required');
      }
      const desktopId = String(request.params.desktopId);
      if (body.op === 'drop' && ['observe', 'control'].includes(body.access)) { await computers.dropDesktopClaim(body.origin, body.assignmentId, actor as ComputerActor, desktopId, body.access as ComputerAccess); response.json({ released: true }); }
      else if (body.op === 'claim' && ['observe', 'control'].includes(body.access)) {
        response.json({ token: await computers.claimDesktop(body.origin, body.assignmentId, actor as ComputerActor, desktopId, body.access as ComputerAccess) });
      } else throw new HarnessServiceError('invalid-params', 'Unknown desktop assignment operation');
    } catch (error) { sendError(response, error, 'Unable to coordinate desktop assignment'); }
  });
  // The authenticated peer must carry a Host-issued assignment. Human viewer input has its own
  // takeover identity; a raw automatic endpoint is never a second bypass around Thread admission.
  app.use('/api/computers/desktops/:desktopId', requireAuth, (request, response, next) => {
    const operation = request.path.slice(1);
    const automatic = request.method === 'POST' && ['observe', 'act', 'open', 'cancel', 'release', 'browser', 'office', 'software', 'artifacts/write'].includes(operation);
    const token = request.get('X-Varin-Computer-Lease');
    if (!automatic && !token) { next(); return; }
    if (!token) { sendError(response, new HarnessServiceError('forbidden', 'Automatic input requires a Host desktop assignment'), 'Assignment required'); return; }
    const body = request.body;
    const read = request.method === 'GET' || operation === 'observe'
      || operation === 'browser' && (['status', 'tabs', 'snapshot'].includes(body?.op) || body?.op === 'act' && body?.act?.kind === 'screenshot')
      || operation === 'office' && (['status', 'docs'].includes(body?.op) || body?.op === 'act' && body?.act?.kind === 'read');
    void computers.automation.delegated(token, String(request.params.desktopId), read ? 'observe' : 'control', () => new Promise<void>(resolve => {
      response.once('finish', resolve); response.once('close', resolve); next();
    })).catch(error => { if (!response.headersSent) sendError(response, error, 'Desktop assignment ended'); });
  });

  const sendArtifact = (response: Response, source: Awaited<ReturnType<ComputerService["openDesktopArtifact"]>>) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/octet-stream");
    response.once("close", source.cancel);
    source.stream.once("error", (error) => {
      if (response.headersSent) response.destroy(error);
      else {
        response.removeHeader("Content-Disposition");
        response.removeHeader("Content-Length");
        sendError(response, error, "Unable to read desktop artifact");
      }
    });
    source.stream.pipe(response);
  };

  app.post("/api/computers/desktops/:desktopId/artifacts/inspect", requireAuth, async (request, response) => {
    try { response.json({ version: await computers.inspectArtifact(String(request.params.desktopId), request.body?.relativePath) }); }
    catch (error) { sendError(response, error, "Unable to inspect desktop artifact"); }
  });
  app.get("/api/computers/desktops/:desktopId/artifacts/read", requireAuth, async (request, response) => {
    try {
      const path = typeof request.query.path === "string" ? request.query.path : "";
      const sha256 = typeof request.query.sha256 === "string" ? request.query.sha256 : "";
      const source = await computers.openDesktopArtifact(String(request.params.desktopId), path, sha256);
      response.setHeader("X-Varin-Artifact-Sha256", sha256);
      sendArtifact(response, source);
    } catch (error) { sendError(response, error, "Unable to read desktop artifact"); }
  });
  app.get("/api/computers/artifacts/:artifactId/content", requireAuth, async (request, response) => {
    try {
      const source = await computers.openArtifact(String(request.params.artifactId));
      response.attachment(source.artifact.relativePath.split("/").at(-1) || "artifact");
      response.setHeader("X-Varin-Artifact-Sha256", source.artifact.sha256);
      response.setHeader("Content-Length", String(source.artifact.byteLength));
      sendArtifact(response, source);
    } catch (error) { sendError(response, error, "Unable to download computer artifact"); }
  });

  /** Re-probe a desktop's driver and persist the real capability table. */
  app.post("/api/computers/desktops/prepare", requireAuth, async (request, response) => {
    try { response.json({ desktop: await computers.prepareDesktop(request.body ?? {}, request.body?.automation === true) }); }
    catch (error) { sendError(response, error, "Unable to prepare desktop"); }
  });
  app.post("/api/computers/desktops/:desktopId/lifecycle", requireAuth, async (request, response) => {
    try { response.json({ desktop: await computers.desktopLifecycle(String(request.params.desktopId), request.body?.action, request.body?.automation === true) }); }
    catch (error) { sendError(response, error, "Unable to change desktop lifecycle"); }
  });

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

  // --- Host-to-Host computer API (BC6) ---------------------------------------
  // The same endpoints a remote coordinator Host calls to operate this
  // machine's desktops; they are also how authenticated remote clients drive.

  /** One structured observation of an app window on this desktop. */
  app.post("/api/computers/desktops/:desktopId/observe", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const observation = await computers.observe({
        desktopId: String(request.params.desktopId ?? ""),
        app: typeof body.app === "string" ? body.app : "",
        signal: controller.signal,
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(body.window !== undefined && (typeof body.window === "number" || typeof body.window === "string")
          ? { window: body.window } : {}),
        ...(typeof body.includeScreenshot === "boolean" ? { includeScreenshot: body.includeScreenshot } : {}),
        ...(typeof body.textLimit === "number" || body.textLimit === "max" ? { textLimit: body.textLimit } : {}),
        ...(typeof body.observationId === 'string' ? { observationId: body.observationId } : {}),
        ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
        ...(typeof body.maxTreeNodes === "number" ? { maxTreeNodes: body.maxTreeNodes } : {}),
        ...(typeof body.maxTreeDepth === "number" ? { maxTreeDepth: body.maxTreeDepth } : {}),
      });
      response.json({ observation });
    } catch (error) {
      sendError(response, error, "Unable to observe the desktop");
    }
  });

  /** One structured automated action against an app on this desktop. */
  app.post("/api/computers/desktops/:desktopId/act", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const result = await computers.act({
        desktopId: String(request.params.desktopId ?? ""),
        action: request.body?.action,
        signal: controller.signal,
        ...(typeof request.body?.sessionId === "string" ? { sessionId: request.body.sessionId } : {}),
        ...(typeof request.body?.automationEpoch === "string" ? { automationEpoch: request.body.automationEpoch } : {}),
      });
      response.json({ result });
    } catch (error) {
      sendError(response, error, "Unable to run the computer action");
    }
  });

  /** App inventory on this desktop. */
  app.get("/api/computers/desktops/:desktopId/apps", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ apps: await computers.listApps(String(request.params.desktopId ?? "")) });
    } catch (error) {
      sendError(response, error, "Unable to list desktop apps");
    }
  });

  /** Cancel queued automation and release held input on this desktop. */
  app.post("/api/computers/desktops/:desktopId/cancel", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await computers.cancel(String(request.params.desktopId ?? "")));
    } catch (error) {
      sendError(response, error, "Unable to cancel desktop actions");
    }
  });

  /** Release held synthetic input on this desktop. */
  app.post("/api/computers/desktops/:desktopId/release", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await computers.release(String(request.params.desktopId ?? "")));
    } catch (error) {
      sendError(response, error, "Unable to release desktop input");
    }
  });

  /** Open a URL/path/application on this machine (EE) — the open resolves
   * here: `localhost` and file paths are this machine's own. */
  app.post("/api/computers/desktops/:desktopId/open", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.open({
        desktopId: String(request.params.desktopId ?? ""),
        signal: controller.signal,
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        ...(typeof body.command === "string" ? { command: body.command } : {}),
        ...(body.args !== undefined ? { args: body.args } : {}),
        ...(typeof body.automationEpoch === "string" ? { automationEpoch: body.automationEpoch } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      });
      response.json({ result });
    } catch (error) {
      sendError(response, error, "Unable to open the target on the desktop");
    }
  });

  /** One-shot file write into the managed desktop user's home (EE). */
  app.post("/api/computers/desktops/:desktopId/artifacts/write", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.fileWrite({
        desktopId: String(request.params.desktopId ?? ""),
        relativePath: typeof body.relativePath === "string" ? body.relativePath : "",
        contentBase64: body.contentBase64,
        signal: controller.signal,
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to write the desktop file");
    }
  });

  /** Install recipe component groups or explicit packages into the
   * environment owning this desktop (EE §6.2). */
  app.post("/api/computers/desktops/:desktopId/software", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.installSoftware({
        desktopId: String(request.params.desktopId ?? ""),
        ...(body.groups !== undefined ? { groups: body.groups } : {}),
        ...(body.packages !== undefined ? { packages: body.packages } : {}),
        signal: controller.signal,
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to install software on the desktop's environment");
    }
  });

  /** Browser bridge: CDP ops against the visible Chromium session (EE §7.2). */
  app.post("/api/computers/desktops/:desktopId/browser", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.browser({
        desktopId: String(request.params.desktopId ?? ""),
        op: body.op,
        signal: controller.signal,
        ...(typeof body.automationEpoch === "string" ? { automationEpoch: body.automationEpoch } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.tabId === "string" ? { tabId: body.tabId } : {}),
        ...(typeof body.binary === "string" ? { binary: body.binary } : {}),
        ...(typeof body.profile === "string" ? { profile: body.profile } : {}),
        ...(typeof body.port === "number" ? { port: body.port } : {}),
        ...(body.act !== null && typeof body.act === "object" ? { act: body.act } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to reach the browser bridge");
    }
  });

  app.post("/api/computers/desktops/:desktopId/office", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.office({
        desktopId: String(request.params.desktopId ?? ""),
        op: body.op,
        signal: controller.signal,
        ...(typeof body.automationEpoch === "string" ? { automationEpoch: body.automationEpoch } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(body.act !== null && typeof body.act === "object" ? { act: body.act } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to reach the LibreOffice bridge");
    }
  });

  app.post("/api/computers/desktops/:desktopId/evidence", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const body = request.body ?? {};
      const result = await computers.evidence({
        desktopId: String(request.params.desktopId ?? ""),
        signal: controller.signal,
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.since === "number" ? { since: body.since } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to read the desktop evidence journal");
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
        ...(typeof request.body?.controlEpoch === "string" ? { controlEpoch: request.body.controlEpoch } : {}),
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
    let closed = false;
    response.on("close", () => { closed = true; unsubscribe?.(); });
    try {
      unsubscribe = await computers.subscribeFrames(desktopId, viewerId, (event) => {
        if (closed || response.writableEnded) return;
        // A slow viewer needs the next current frame, not an ever-growing
        // backlog of obsolete screenshots. Control receipts are still sent.
        if (event.type === "frame" && response.writableNeedDrain) return;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "error" && event.terminal) response.end();
      }, { frames: request.query.frames !== "0" });
    } catch (error) {
      response.write(`data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "subscribe failed" })}\n\n`);
      response.end();
      return;
    }
    if (closed) unsubscribe();
  });

  // --- BC7: virtual machine lifecycle ---------------------------------------
  // Real provider-backed VMs (libvirt today). Machine records keep the domain
  // UUID + volume journal; delete keeps persistent disks unless asked.

  /** Virtual machines on configured providers, with live domain state. */
  app.get("/api/computers/vms", requireAuth, async (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ vms: await computers.listVms() });
    } catch (error) {
      sendError(response, error, "Unable to list virtual machines");
    }
  });

  /**
   * Create/resume a VM on a configured provider using its durable creation
   * identity. A matching external domain name is rejected, never adopted.
   */
  app.post("/api/computers/vms", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const body = request.body ?? {};
      const result = await computers.createVm({
        providerId: String(body.providerId ?? ""),
        name: String(body.name ?? ""),
        ...(typeof body.memoryMiB === "number" ? { memoryMiB: body.memoryMiB } : {}),
        ...(typeof body.vcpus === "number" ? { vcpus: body.vcpus } : {}),
        ...(typeof body.diskGiB === "number" ? { diskGiB: body.diskGiB } : {}),
        ...(typeof body.managed === "boolean" ? { managed: body.managed } : {}),
        ...(typeof body.baseImage === "string" ? { baseImage: body.baseImage } : {}),
      });
      response.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      sendError(response, error, "Unable to create the virtual machine");
    }
  });

  /** Start / graceful shutdown / reboot — keyed on the recorded domain UUID. */
  app.post("/api/computers/vms/:machineId/:action", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const action = String(request.params.action ?? "");
    if (action === "delete") {
      try {
        await computers.deleteVm(
          String(request.params.machineId ?? ""),
          request.body?.deleteDisks === true,
        );
        response.json({ ok: true });
      } catch (error) {
        sendError(response, error, "Unable to delete the virtual machine");
      }
      return;
    }
    if (action !== "start" && action !== "shutdown" && action !== "reboot" && action !== "upgrade") {
      sendError(response, new HarnessServiceError("invalid-params", `Unknown VM action "${action}"`), "Unknown VM action");
      return;
    }
    try {
      const vm = await computers.vmAction({
        machineId: String(request.params.machineId ?? ""),
        action,
      });
      response.json({ vm });
    } catch (error) {
      sendError(response, error, "Unable to run the VM action");
    }
  });
}
