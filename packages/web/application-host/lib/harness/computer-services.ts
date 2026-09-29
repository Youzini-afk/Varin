import type { HarnessServiceMap } from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
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

export function createComputerListService(host: HarnessServiceHost): HarnessService<"computer.list"> {
  return {
    handle: async () => requireService(host).list(),
  };
}

export function createComputerAppsService(host: HarnessServiceHost): HarnessService<"computer.apps"> {
  return {
    handle: async (params) => ({ apps: await requireService(host).listApps(desktopIdParam(params)) }),
  };
}

export function createComputerObserveService(host: HarnessServiceHost): HarnessService<"computer.observe"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const app = typeof params.app === "string" ? params.app.trim() : "";
      if (!app) throw new HarnessServiceError("invalid-params", "computer.observe requires app");
      const desktopId = desktopIdParam(params);
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
      const desktopId = desktopIdParam(params);
      const result = await requireService(host).act({
        ...(desktopId ? { desktopId } : {}),
        action: params.action,
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
      return { result };
    },
  };
}

export function createComputerCancelService(host: HarnessServiceHost): HarnessService<"computer.cancel"> {
  return {
    handle: async (params) => requireService(host).cancel(desktopIdParam(params)),
  };
}

export function createComputerReleaseService(host: HarnessServiceHost): HarnessService<"computer.release"> {
  return {
    handle: async (params) => requireService(host).release(desktopIdParam(params)),
  };
}

export function registerComputerServices(
  router: { register: <M extends keyof HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
): void {
  if (!host.computerService) return;
  router.register("computer.list", createComputerListService(host));
  router.register("computer.apps", createComputerAppsService(host));
  router.register("computer.observe", createComputerObserveService(host));
  router.register("computer.act", createComputerActService(host));
  router.register("computer.cancel", createComputerCancelService(host));
  router.register("computer.release", createComputerReleaseService(host));
}
