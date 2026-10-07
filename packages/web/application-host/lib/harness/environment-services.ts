import type {
  EnvironmentForwardCloseResult,
  EnvironmentForwardListResult,
  EnvironmentForwardResult,
  EnvironmentGetResult,
  EnvironmentServiceAccess,
  EnvironmentSetResult,
  ThreadEnvironment,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { isAttachedRootPurpose } from '@varin/protocol';
import { createEnvironmentForwardRuntime, type EnvironmentForwardRuntime } from "./environment-forwards.js";

/**
 * Execution-environment binding services (execution-environment design §5).
 * A Thread's environment is a durable placement default: which managed
 * execution target runs its shell/process operations and which computer
 * desktop its GUI operations address. Consumers resolve it once per
 * admitted operation — an accepted operation keeps the target it was pinned
 * with, so rebinding can never redirect in-flight work and is never
 * reported as a migration.
 */

const scopeOf = (ctx: HarnessServiceContext): string => ctx.workspaceId ?? `session:${ctx.sessionId}`;

/**
 * Resolve the calling session's Thread environment. Returns null when the
 * session carries no Thread. A failed binding read must fail the operation:
 * falling back could execute a remote command on this Host instead.
 */
export const sessionEnvironment = async (
  host: HarnessServiceHost,
  sessionId: string,
): Promise<{ threadId: string; environment: ThreadEnvironment | null } | null> => {
  const registry = host.threadRegistry;
  if (!registry) return null;
  return registry.threadEnvironmentForSession(sessionId);
};
const assertWritableEnvironment = async (host: HarnessServiceHost, sessionId: string) => {
  const registry = host.threadRegistry;
  const owner = await registry?.resolveSessionOwner(sessionId);
  if (!registry || !owner) return;
  const thread = await registry.getThreadById(owner.owningScopeId, owner.threadId);
  if (thread?.preset === 'retrieval' || thread?.kind === 'discussion' && !isAttachedRootPurpose(thread.purpose)) throw new HarnessServiceError('forbidden', 'Read-only threads cannot change execution placement or service forwards');
};

export const validateEnvironment = async (
  host: HarnessServiceHost,
  scopeId: string,
  value: unknown,
): Promise<{ workTarget?: string; desktopId?: string }> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessServiceError("invalid-params", "environment must be an object");
  }
  const result: { workTarget?: string; desktopId?: string } = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "workTarget" && key !== "desktopId") throw new HarnessServiceError("invalid-params", `Unknown environment field: ${key}`);
    if (typeof field !== "string" || !field.trim()) throw new HarnessServiceError("invalid-params", `environment.${key} must be a non-empty string`);
    result[key] = field.trim();
  }
  if (result.workTarget && result.workTarget !== "local") {
    if (!await host.managedRemoteTargets?.targetFor(scopeId, result.workTarget)) {
      throw new HarnessServiceError("unavailable", `No managed execution target is registered for ${result.workTarget}`);
    }
  }
  if (result.desktopId) {
    if (!host.computerService) throw new HarnessServiceError("unavailable", "Computer service is not configured");
    const { desktops } = await host.computerService.list();
    if (!desktops.some((desktop) => desktop.id === result.desktopId)) throw new HarnessServiceError("invalid-params", `Unknown computer desktop: ${result.desktopId}`);
  }
  return result;
};

export function createEnvironmentGetService(host: HarnessServiceHost): HarnessService<"environment.get"> {
  return {
    handle: async (_params, ctx) => {
      const bound = await sessionEnvironment(host, ctx.sessionId);
      const result: EnvironmentGetResult = bound
        ? { threadId: bound.threadId, environment: bound.environment }
        : { threadId: null, environment: null };
      return result;
    },
  };
}

export function createEnvironmentSetService(host: HarnessServiceHost): HarnessService<"environment.set"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry is not configured");
      const owner = await registry.resolveSessionOwner(ctx.sessionId);
      if (!owner) {
        throw new HarnessServiceError("unavailable", "This session carries no Thread; environment bindings live on work Threads");
      }
      await assertWritableEnvironment(host, ctx.sessionId);
      const patch: { workTarget?: string | null; desktopId?: string | null } = {};
      const invalid = (field: string) => {
        throw new HarnessServiceError("invalid-params", `environment.${field} must be a string or null`);
      };
      if (params.workTarget !== undefined) {
        if (params.workTarget === null) patch.workTarget = null;
        else if (typeof params.workTarget !== "string") invalid("workTarget");
        else patch.workTarget = params.workTarget.trim() || null;
      }
      if (params.desktopId !== undefined) {
        if (params.desktopId === null) patch.desktopId = null;
        else if (typeof params.desktopId !== "string") invalid("desktopId");
        else patch.desktopId = params.desktopId.trim() || null;
      }
      // Placement must be verifiably real before it is recorded: an unknown
      // machine or desktop id would only fail later at each accepted
      // operation, hiding the configuration error.
      if (patch.workTarget !== undefined && patch.workTarget !== null && patch.workTarget !== "local") {
        const target = host.managedRemoteTargets
          ? await host.managedRemoteTargets.targetFor(scopeOf(ctx), patch.workTarget)
          : null;
        if (!target) {
          throw new HarnessServiceError("unavailable",
            `No managed execution target is registered for ${patch.workTarget}`);
        }
      }
      if (patch.desktopId !== undefined && patch.desktopId !== null) {
        if (!host.computerService) throw new HarnessServiceError("unavailable", "Computer service is not configured");
        const { desktops } = await host.computerService.list();
        if (!desktops.some((desktop) => desktop.id === patch.desktopId)) {
          throw new HarnessServiceError("invalid-params", `Unknown computer desktop: ${patch.desktopId}`);
        }
      }
      const { environment, previous } = await registry.setThreadEnvironment(owner.owningScopeId, owner.threadId, patch);
      // Report what the change actually does: later-admitted operations take
      // the new placement, already-accepted operations keep their pinned
      // target, and nothing is copied or migrated.
      const parts: string[] = [];
      if ((patch.workTarget !== undefined) && patch.workTarget !== (previous?.workTarget ?? null)) {
        const to = environment?.workTarget ?? "this Host";
        const from = previous?.workTarget ?? "this Host";
        parts.push(to === from
          ? `Commands continue to run on ${to}.`
          : `Commands admitted from now run on ${to}; commands and shells already accepted on ${from} keep running there and stay addressable by their ids.`);
      }
      if ((patch.desktopId !== undefined) && patch.desktopId !== (previous?.desktopId ?? null)) {
        const to = environment?.desktopId ?? "the configured default desktop";
        const from = previous?.desktopId ?? "the configured default desktop";
        parts.push(to === from
          ? `GUI operations continue to target ${to}.`
          : `GUI operations admitted from now target ${to}; operations already accepted stay pinned to ${from}.`);
      }
      const result: EnvironmentSetResult = {
        threadId: owner.threadId,
        environment,
        previous,
        handoff: parts.length ? parts.join(" ") : null,
      };
      return result;
    },
  };
}

/**
 * Resolve the service's target machine for `environment.forward`: an
 * explicit param wins, then the calling work's bound workTarget, then this
 * Host itself.
 */
const forwardTargetId = async (
  host: HarnessServiceHost,
  ctx: HarnessServiceContext,
  explicit: unknown,
): Promise<string> => {
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || !explicit.trim()) {
      throw new HarnessServiceError("invalid-params", "environment.forward target must be a machine id");
    }
    return explicit.trim();
  }
  const bound = await sessionEnvironment(host, ctx.sessionId);
  return bound?.environment?.workTarget ?? "local";
};

export function createEnvironmentForwardServices(
  host: HarnessServiceHost,
  runtime: EnvironmentForwardRuntime = host.environmentForwards ?? createEnvironmentForwardRuntime(),
): { forward: HarnessService<"environment.forward">; forwards: HarnessService<"environment.forwards">; forwardClose: HarnessService<"environment.forwardClose">; runtime: EnvironmentForwardRuntime } {
  const forward: HarnessService<"environment.forward"> = {
    handle: async (params, ctx) => {
      await assertWritableEnvironment(host, ctx.sessionId);
      const port = Number(params.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new HarnessServiceError("invalid-params", "environment.forward requires a port between 1 and 65535");
      }
      let serviceHost = "127.0.0.1";
      if (params.host !== undefined && params.host !== null) {
        if (typeof params.host !== "string" || !params.host.trim()) {
          throw new HarnessServiceError("invalid-params", "environment.forward host must be a non-empty address");
        }
        serviceHost = params.host.trim();
      }
      const targetId = await forwardTargetId(host, ctx, params.target);
      const bound = await sessionEnvironment(host, ctx.sessionId);
      if (targetId === "local") {
        // The service's own address is already reachable — report it without
        // manufacturing a relay.
        const access: EnvironmentServiceAccess = {
          id: `envsvc:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          service: { machineId: "local", host: serviceHost, port },
          access: { kind: "direct", machineId: "local", host: serviceHost, port, url: `http://${serviceHost}:${port}` },
          threadId: bound?.threadId ?? null,
          createdAt: new Date().toISOString(),
        };
        return { access } satisfies EnvironmentForwardResult;
      }
      if (!host.managedRemoteTargets) throw new HarnessServiceError("unavailable", "No managed execution targets are configured");
      const target = await host.managedRemoteTargets.targetFor(scopeOf(ctx), targetId);
      if (!target) {
        throw new HarnessServiceError("unavailable", `No managed execution target is reachable as ${targetId}`);
      }
      // VM guests have no network path through this channel; desktops reached
      // over the computer API expose their services through their owning
      // Host's managed target instead.
      const access = await runtime.open({ target, host: serviceHost, port, threadId: bound?.threadId ?? null,
        sessionId: ctx.sessionId, signal: ctx.signal });
      return { access } satisfies EnvironmentForwardResult;
    },
  };
  const forwards: HarnessService<"environment.forwards"> = {
    handle: async (_params, ctx) => ({ accesses: runtime.list(ctx.sessionId) }) satisfies EnvironmentForwardListResult,
  };
  const forwardClose: HarnessService<"environment.forwardClose"> = {
    handle: async (params, ctx) => {
      await assertWritableEnvironment(host, ctx.sessionId);
      if (typeof params.id !== "string" || !params.id) throw new HarnessServiceError("invalid-params", "environment.forwardClose requires an access id");
      const closed = await runtime.close(params.id, ctx.sessionId);
      return { closed } satisfies EnvironmentForwardCloseResult;
    },
  };
  return { forward, forwards, forwardClose, runtime };
}

export function registerEnvironmentServices(
  router: { register: <M extends keyof import("@varin/protocol").HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
  forwardRuntime?: EnvironmentForwardRuntime,
): void {
  if (!host.threadRegistry) return;
  router.register("environment.get", createEnvironmentGetService(host));
  router.register("environment.set", createEnvironmentSetService(host));
  const forwardServices = createEnvironmentForwardServices(host, forwardRuntime);
  router.register("environment.forward", forwardServices.forward);
  router.register("environment.forwards", forwardServices.forwards);
  router.register("environment.forwardClose", forwardServices.forwardClose);
}
