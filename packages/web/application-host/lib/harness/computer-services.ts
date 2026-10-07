import type { HarnessServiceMap, ComputerAccess } from "@varin/protocol";
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
  const computers = host.computerService;
  router.register('computer.access', { handle: async (params, ctx) => {
    const coordinator = computers.automation;
    let request;
    if (params.op === 'request') {
      const access: ComputerAccess = params.access ?? 'control';
      if (!['observe', 'control'].includes(access)) throw new HarnessServiceError('invalid-params', 'Unknown desktop access mode');
      const desktopId = await computers.resolveDesktop(await desktopIdFor(host, ctx, params));
      request = await coordinator.request(ctx.sessionId, desktopId, access, params.reason ?? '');
      if (params.wait && request.status === 'pending') {
        const binding = await host.threadRegistry?.getSessionBinding(ctx.sessionId);
        if (binding && host.threadRegistry) await host.threadRegistry.yieldExecutionSlot(binding.owningScopeId, binding.threadId, binding.runId,
          { kind: 'thread', text: `Waiting for the main thread to assign desktop ${desktopId}` });
        try { request = await coordinator.wait(ctx.sessionId, request.id, ctx.signal); }
        finally { if (binding && !ctx.signal.aborted) await host.threadRegistry?.awaitExecutionSlot(binding.owningScopeId, binding.threadId, binding.runId, ctx.signal); }
      }
    } else if (params.op === 'grant' || params.op === 'deny') {
      if (!ctx.actor.grantedCapabilities.includes('control.computer')) throw new HarnessServiceError('forbidden', 'Desktop grants require Computer Use control authorization');
      if (!params.requestId) throw new HarnessServiceError('invalid-params', 'Supply requestId');
      request = await coordinator.decide(ctx.sessionId, params.requestId, params.op === 'grant', params.reason);
    } else if (params.op === 'release') await coordinator.release(ctx.sessionId, params.desktopId);
    else if (params.op !== 'status') throw new HarnessServiceError('invalid-params', 'Unknown access operation');
    return { state: await coordinator.snapshot(ctx.sessionId), ...(request ? { request } : {}) };
  } });
  const register: typeof router.register = (method, service) => router.register(method, {
    handle: (params, ctx) => computers.automation.authorize(ctx.sessionId, 'observe', undefined, async () => {
      const metadata = ['computer.list', 'computer.evidence'].includes(method);
      const bridge = params as { op?: string; act?: { kind?: string } };
      const bridgeRead = method === 'computer.browser' && (['status', 'tabs', 'snapshot'].includes(bridge.op ?? '') || bridge.op === 'act' && bridge.act?.kind === 'screenshot')
        || method === 'computer.office' && (['status', 'docs'].includes(bridge.op ?? '') || bridge.op === 'act' && bridge.act?.kind === 'read');
      const access: ComputerAccess = bridgeRead || ['computer.apps', 'computer.observe', 'computer.list', 'computer.control', 'computer.evidence'].includes(method) ? 'observe' : 'control';
      const requested = params as { desktopId?: string };
      const desktopId = metadata || method === 'computer.prepare' ? undefined
        : await computers.resolveDesktop(await desktopIdFor(host, ctx, requested));
      return computers.automation.authorize(ctx.sessionId, access, desktopId, () => service.handle(
        desktopId ? { ...params, desktopId } : params, ctx,
      ));
    }),
  });
  register("computer.list", createComputerListService(host));
  register("computer.prepare", { handle: async (params) => ({ desktop: await requireService(host).prepareDesktop(params, true) }) });
  register("computer.desktopLifecycle", { handle: async (params) => ({ desktop: await requireService(host).desktopLifecycle(params.desktopId, params.action, true) }) });
  register("computer.artifact", { handle: async (params, ctx) => ({ artifact: await requireService(host).registerArtifact(ctx.sessionId, await desktopIdFor(host, ctx, params), params.relativePath) }) });
  register("computer.control", { handle: async (params, ctx) => ({ control: await requireService(host).control(await desktopIdFor(host, ctx, params)) }) });
  register("computer.apps", createComputerAppsService(host));
  register("computer.observe", createComputerObserveService(host));
  register("computer.act", createComputerActService(host));
  register("computer.cancel", createComputerCancelService(host));
  register("computer.release", createComputerReleaseService(host));
  // EE: cross-environment open + one-shot file write resolve the bound
  // desktop the same way as observe/act.
  register("computer.open", {
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
  register("computer.fileWrite", {
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
  register("computer.installSoftware", {
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
  register("computer.browser", {
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
  register("computer.office", {
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
  register("computer.evidence", {
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
