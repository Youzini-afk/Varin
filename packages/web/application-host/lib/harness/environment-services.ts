import type {
  EnvironmentGetResult,
  EnvironmentSetResult,
  ThreadEnvironment,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";

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
 * session carries no Thread; binding inconsistencies also yield null so a
 * damaged binding cannot silently break every operation — the set path
 * surfaces the same registry error to the caller instead.
 */
export const sessionEnvironment = async (
  host: HarnessServiceHost,
  sessionId: string,
): Promise<{ threadId: string; environment: ThreadEnvironment | null } | null> => {
  const registry = host.threadRegistry;
  if (!registry) return null;
  try { return await registry.threadEnvironmentForSession(sessionId); }
  catch { return null; }
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
      if (patch.workTarget !== undefined && patch.workTarget !== null) {
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

export function registerEnvironmentServices(
  router: { register: <M extends keyof import("@varin/protocol").HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
): void {
  if (!host.threadRegistry) return;
  router.register("environment.get", createEnvironmentGetService(host));
  router.register("environment.set", createEnvironmentSetService(host));
}
