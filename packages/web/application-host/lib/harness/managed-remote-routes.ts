import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { VarinAuthenticatedClient } from "../client-auth/request-context.js";
import type { ManagedRemoteExecutionService } from "./managed-remote-service.js";
import { requestBodyChunks } from "./managed-remote-service.js";

export interface ManagedRemoteRoutesOptions {
  service: ManagedRemoteExecutionService;
  requireAuth?: RequestHandler;
  resolveAuthContext?: (
    request: Request,
    response: Response | null,
    options: { allowClientAuth: boolean; allowUrlToken: boolean },
  ) => Promise<{
    type: string;
    clientId?: string | null;
    client?: VarinAuthenticatedClient | null;
  } | null>;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const value = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const asString = (input: unknown, label: string): string => {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required`);
  return input.trim();
};
const asNonNegativeInteger = (input: unknown, label: string): number => {
  const parsed = typeof input === "string" && /^\d+$/.test(input) ? Number(input) : input;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(parsed);
};

const sendError = (response: Response, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /required|invalid|must |cannot contain|repeats path|outside|conflict|bound to another/i.test(message) ? 400
    : /unknown|unavailable|not ready|missing|unconfirmed|still active/i.test(message) ? 503
      : 500;
  response.status(status).json({ error: message });
};

const whileResponseOpen = async <T>(response: Response, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => { if (!response.writableEnded) controller.abort(); };
  response.once("close", abort);
  if (response.destroyed) abort();
  try { return await work(controller.signal); }
  finally { response.off("close", abort); }
};

const route = (handler: (request: Request, response: Response) => Promise<void>) => (
  async (request: Request, response: Response, next: NextFunction) => {
    try { await handler(request, response); } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) next(error);
      else sendError(response, error);
    }
  }
);

export function registerManagedRemoteRoutes(
  app: Express,
  { service, requireAuth = noAuth, resolveAuthContext }: ManagedRemoteRoutesOptions,
): void {
  const base = "/api/harness/managed-execution/v1";
  const principals = new WeakMap<Request, string>();
  const requiredCapabilities = ["filesystem:read", "filesystem:write", "logs:read", "terminal:use", "process:control"];
  const requireManagedAuth: RequestHandler = async (request, response, next) => {
    try {
      const auth = await resolveAuthContext?.(request, response, { allowClientAuth: true, allowUrlToken: false });
      if (auth?.type !== "client" || !auth.clientId || !auth.client) {
        response.status(403).json({ error: "Managed execution requires a stable authenticated client" });
        return;
      }
      const capabilities = new Set(Array.isArray(auth.client.capabilities) ? auth.client.capabilities : []);
      const missing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
      if (missing.length > 0) {
        response.status(403).json({ error: `Managed execution capability is unavailable: ${missing.join(", ")}` });
        return;
      }
      principals.set(request, auth.clientId);
      next();
    } catch (error) { next(error); }
  };
  const authorize = (request: Request, coordinatorHostId: unknown): { coordinatorHostId: string; principalId: string } => {
    const coordinator = asString(coordinatorHostId, "Coordinator identity");
    const principal = principals.get(request);
    if (!principal) throw new Error("Managed execution has no authenticated principal");
    return { coordinatorHostId: coordinator, principalId: principal };
  };
  app.use(base, (_request, response, next) => {
    response.setHeader("X-Varin-Managed-Host", service.hostId);
    next();
  });

  app.get(`${base}/identity`, requireAuth, requireManagedAuth, route(async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.identity());
  }));

  app.get(`${base}/lifecycle`, requireAuth, requireManagedAuth, route(async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.lifecycle());
  }));

  app.post(`${base}/materials/probe`, requireAuth, requireManagedAuth, route(async (request, response) => {
    authorize(request, value(request.body).coordinatorHostId);
    response.json(await service.probeMaterial(request.body));
  }));

  app.put(`${base}/objects/:objectHash`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const coordinatorHostId = asString(request.header("x-varin-coordinator-host"), "Coordinator identity");
    authorize(request, coordinatorHostId);
    const objectHash = asString(request.params.objectHash, "Object identity");
    const byteLength = asNonNegativeInteger(request.header("x-varin-object-length"), "Object byte length");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    try {
      response.json(await service.putObject(coordinatorHostId, objectHash, byteLength, requestBodyChunks(request), controller.signal));
    } finally {
      request.off("aborted", abort);
    }
  }));

  app.post(`${base}/materials/commit`, requireAuth, requireManagedAuth, route(async (request, response) => {
    authorize(request, value(request.body).coordinatorHostId);
    response.json(await service.commitMaterial(request.body));
  }));

  app.post(`${base}/resources/admit`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, value(request.body).coordinatorHostId);
    response.json(await service.admit(request.body, owner.principalId));
  }));

  app.post(`${base}/resources/release`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const body = value(request.body);
    const owner = authorize(request, body.coordinatorHostId);
    await service.releaseAdmission({
      coordinatorHostId: asString(body.coordinatorHostId, "Coordinator identity"),
      workspaceId: asString(body.workspaceId, "Workspace identity"),
      machineId: asString(body.machineId, "Machine identity"),
      attemptId: asString(body.attemptId, "Attempt identity"),
      resources: value(body.resources),
      commitmentId: asString(body.commitmentId, "Commitment identity"),
      reason: typeof body.reason === "string" ? body.reason : "coordinator released remote commitment",
    }, owner.principalId);
    response.json({ released: true });
  }));

  app.post(`${base}/jobs/submit`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, value(request.body).coordinatorHostId);
    response.json(await service.submitJob(request.body, owner.principalId));
  }));

  app.get(`${base}/jobs/:coordinatorHostId/:backendJobId`, requireAuth, requireManagedAuth, route(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.inspectJob(owner.principalId, owner.coordinatorHostId, asString(request.params.backendJobId, "Job identity")));
  }));

  app.get(`${base}/jobs/:coordinatorHostId/:backendJobId/output`, requireAuth, requireManagedAuth, route(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const cursor = request.query.cursor === undefined ? 0 : asNonNegativeInteger(request.query.cursor, "Output cursor");
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.readJob(owner.principalId, owner.coordinatorHostId, asString(request.params.backendJobId, "Job identity"), cursor));
  }));

  app.post(`${base}/jobs/:coordinatorHostId/:backendJobId/kill`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.killJob(owner.principalId, owner.coordinatorHostId, asString(request.params.backendJobId, "Job identity")));
  }));

  app.post(`${base}/jobs/:coordinatorHostId/:backendJobId/release`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    await service.releaseJob(owner.principalId, owner.coordinatorHostId, asString(request.params.backendJobId, "Job identity"));
    response.json({ released: true });
  }));

  app.post(`${base}/jobs/:coordinatorHostId/:backendJobId/outputs`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.collectOutput(
      owner.principalId,
      owner.coordinatorHostId,
      asString(request.params.backendJobId, "Job identity"),
      asString(value(request.body).path, "Output path"),
    ));
  }));

  app.get(`${base}/outputs/:outputId`, requireAuth, requireManagedAuth, route(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const offset = request.query.offset === undefined ? 0 : asNonNegativeInteger(request.query.offset, "Output offset");
    const length = request.query.length === undefined ? 256 * 1024 : asNonNegativeInteger(request.query.length, "Output length");
    const outputId = asString(request.params.outputId, "Output identity");
    const retainedOwner = await service.ownerForOutput(outputId);
    const principalId = principals.get(request);
    if (!principalId || principalId !== retainedOwner.principalId) throw new Error("Managed remote output belongs to another authenticated connection");
    const page = await service.readOutput(outputId, offset, length);
    response.json(page);
  }));

  app.post(`${base}/shell/exec`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const body = value(request.body);
    const owner = authorize(request, body.coordinatorHostId);
    const result = await whileResponseOpen(response, (signal) => service.shellExec(owner.principalId, {
      coordinatorHostId: owner.coordinatorHostId,
      toolCallId: asString(body.toolCallId, "Tool call identity"),
      command: asString(body.command, "Command"),
      ...(typeof body.cwd === "string" && body.cwd.trim() ? { cwd: body.cwd.trim() } : {}),
      waitMs: body.waitMs === undefined ? 10_000 : asNonNegativeInteger(body.waitMs, "waitMs"),
    }, signal));
    if (!response.destroyed) response.json(result);
  }));

  app.get(`${base}/shell/:coordinatorHostId/:processId`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    const result = await whileResponseOpen(response, (signal) => service.shellRead(
      owner.principalId, owner.coordinatorHostId, asString(request.params.processId, "Shell identity"),
      request.query.offset === undefined ? 0 : asNonNegativeInteger(request.query.offset, "offset"),
      request.query.length === undefined ? 32 * 1024 : asNonNegativeInteger(request.query.length, "length"),
      request.query.waitMs === undefined ? 0 : asNonNegativeInteger(request.query.waitMs, "waitMs"),
      signal,
    ));
    if (!response.destroyed) response.json(result);
  }));

  app.post(`${base}/shell/:coordinatorHostId/:processId/write`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.shellWrite(owner.principalId, owner.coordinatorHostId, asString(request.params.processId, "Shell identity"), String(value(request.body).text ?? "")));
  }));

  app.post(`${base}/shell/:coordinatorHostId/:processId/kill`, requireAuth, requireManagedAuth, route(async (request, response) => {
    const owner = authorize(request, request.params.coordinatorHostId);
    response.json(await service.shellKill(owner.principalId, owner.coordinatorHostId, asString(request.params.processId, "Shell identity")));
  }));
}
