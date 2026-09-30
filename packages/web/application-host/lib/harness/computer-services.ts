import type { HarnessServiceMap } from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { sessionEnvironment } from "./environment-services.js";
import type { ComputerService } from "../computer/computer-service.js";

/**
 * BC4 computer harness services backing the Pi `computer` tool and the
 * script REPL. Element/cancellation semantics live in ComputerService; this
 * layer only validates params and resolves the caller's target desktop.
 */

const requireService = (host: HarnessServiceHost): ComputerService => {
  const service = host.computerService;
  if (!service) throw new HarnessServiceError("unavailable", "Computer service is not configured");
  return service;
};

const desktopIdParam = (params: { desktopId?: string }): string | undefined => (
  typeof params.desktopId === "string" && params.desktopId.trim() ? params.desktopId.trim() : undefined
);

/**
 * Resolve this call's desktop exactly once: an explicit desktopId wins,
 * otherwise the work Thread's environment binding applies, otherwise the
 * ComputerService's configured default. The chosen id is pinned into the
 * request — a later environment change cannot redirect an admitted op.
 */
const desktopIdFor = async (
  host: HarnessServiceHost,
  ctx: HarnessServiceContext,
  params: { desktopId?: string },
): Promise<string | undefined> => (
  desktopIdParam(params) ?? (await sessionEnvironment(host, ctx.sessionId))?.environment?.desktopId
);

export function createComputerListService(host: HarnessServiceHost): HarnessService<"computer.list"> {
  return {
    handle: async () => requireService(host).list(),
  };
}

export function createComputerAppsService(host: HarnessServiceHost): HarnessService<"computer.apps"> {
  return {
    handle: async (params, ctx) => ({ apps: await requireService(host).listApps(await desktopIdFor(host, ctx, params)) }),
  };
}

export function createComputerObserveService(host: HarnessServiceHost): HarnessService<"computer.observe"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const app = typeof params.app === "string" ? params.app.trim() : "";
      if (!app) throw new HarnessServiceError("invalid-params", "computer.observe requires app");
      const desktopId = await desktopIdFor(host, ctx, params);
      const observation = await requireService(host).observe({
        ...(desktopId ? { desktopId } : {}),
        app,
        signal: ctx.signal,
        ...(params.window !== undefined ? { window: params.window } : {}),
        ...(params.includeScreenshot !== undefined ? { includeScreenshot: params.includeScreenshot } : {}),
        ...(params.textLimit !== undefined ? { textLimit: params.textLimit } : {}),
        ...(params.maxTreeNodes !== undefined ? { maxTreeNodes: params.maxTreeNodes } : {}),
        ...(params.maxTreeDepth !== undefined ? { maxTreeDepth: params.maxTreeDepth } : {}),
        sessionId: ctx.sessionId,
      });
      return { observation };
    },
  };
}

export function createComputerActService(host: HarnessServiceHost): HarnessService<"computer.act"> {
  return {
    handle: async (params, ctx) => {
      if (!params.action || typeof params.action !== "object") {
        throw new HarnessServiceError("invalid-params", "computer.act requires an action");
      }
      const desktopId = await desktopIdFor(host, ctx, params);
      const result = await requireService(host).act({
        ...(desktopId ? { desktopId } : {}),
        action: params.action,
        ...(params.automationEpoch !== undefined ? { automationEpoch: params.automationEpoch } : {}),
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
      return { result };
    },
  };
}

export function createComputerCancelService(host: HarnessServiceHost): HarnessService<"computer.cancel"> {
  return {
    handle: async (params, ctx) => requireService(host).cancel(await desktopIdFor(host, ctx, params)),
  };
}

export function createComputerReleaseService(host: HarnessServiceHost): HarnessService<"computer.release"> {
  return {
    handle: async (params, ctx) => requireService(host).release(await desktopIdFor(host, ctx, params)),
  };
}

export function registerComputerServices(
  router: { register: <M extends keyof HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
): void {
  if (!host.computerService) return;
  router.register("computer.list", createComputerListService(host));
  router.register("computer.prepare", { handle: async (params) => ({ desktop: await requireService(host).prepareDesktop(params, true) }) });
  router.register("computer.desktopLifecycle", { handle: async (params) => ({ desktop: await requireService(host).desktopLifecycle(params.desktopId, params.action, true) }) });
  router.register("computer.artifact", { handle: async (params, ctx) => ({ artifact: await requireService(host).registerArtifact(ctx.sessionId, await desktopIdFor(host, ctx, params), params.relativePath) }) });
  router.register("computer.control", { handle: async (params, ctx) => ({ control: await requireService(host).control(await desktopIdFor(host, ctx, params)) }) });
  router.register("computer.apps", createComputerAppsService(host));
  router.register("computer.observe", createComputerObserveService(host));
  router.register("computer.act", createComputerActService(host));
  router.register("computer.cancel", createComputerCancelService(host));
  router.register("computer.release", createComputerReleaseService(host));
  // EE: cross-environment open + one-shot file write resolve the bound
  // desktop the same way as observe/act.
  router.register("computer.open", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).open({
        ...(desktopId !== undefined ? { desktopId } : {}),
        ...(params.url !== undefined ? { url: params.url } : {}),
        ...(params.path !== undefined ? { path: params.path } : {}),
        ...(params.command !== undefined ? { command: params.command } : {}),
        ...(params.automationEpoch !== undefined ? { automationEpoch: params.automationEpoch } : {}),
        ...(params.args !== undefined ? { args: params.args } : {}),
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
    },
  });
  router.register("computer.fileWrite", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).fileWrite({
        ...(desktopId !== undefined ? { desktopId } : {}),
        relativePath: params.relativePath,
        contentBase64: params.contentBase64,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
    },
  });
  // EE §6.2: recipe component install — the environment owning the bound
  // desktop receives the request (remote targets forward to their own Host).
  router.register("computer.installSoftware", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).installSoftware({
        ...(desktopId !== undefined ? { desktopId } : {}),
        ...(params.groups !== undefined ? { groups: params.groups } : {}),
        ...(params.packages !== undefined ? { packages: params.packages } : {}),
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
    },
  });
  // EE §7.2: browser bridge — same lane/ownership gate as observe/act.
  router.register("computer.browser", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).browser({
        ...(desktopId !== undefined ? { desktopId } : {}),
        op: params.op,
        ...(params.automationEpoch !== undefined ? { automationEpoch: params.automationEpoch } : {}),
        ...(params.tabId !== undefined ? { tabId: params.tabId } : {}),
        ...(params.binary !== undefined ? { binary: params.binary } : {}),
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        ...(params.port !== undefined ? { port: params.port } : {}),
        ...(params.act !== undefined ? { act: params.act } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
    },
  });
  // EE §7.2: LibreOffice bridge — same live instance, same ownership gate.
  router.register("computer.office", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).office({
        ...(desktopId !== undefined ? { desktopId } : {}),
        op: params.op,
        ...(params.automationEpoch !== undefined ? { automationEpoch: params.automationEpoch } : {}),
        ...(params.path !== undefined ? { path: params.path } : {}),
        ...(params.url !== undefined ? { url: params.url } : {}),
        ...(params.act !== undefined ? { act: params.act } : {}),
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
    },
  });
  // EE6 (§10): evidence journal — read-only review of executed steps.
  router.register("computer.evidence", {
    handle: async (params, ctx) => {
      const desktopId = await desktopIdFor(host, ctx, params);
      return requireService(host).evidence({
        ...(desktopId !== undefined ? { desktopId } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.since !== undefined ? { since: params.since } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        signal: ctx.signal,
      });
    },
  });
}
