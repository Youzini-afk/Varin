import { ComputerRepl } from "./computer-repl.js";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  ComputerActResult,
  ComputerAction,
  ComputerAppsResult,
  ComputerCancelResult,
  ComputerListResult,
  ComputerObservation,
  ComputerObserveResult,
  ComputerReleaseResult,
} from "@varin/protocol";

/**
 * Computer Use tool (BC4): structured observe/act calls plus a persistent
 * JavaScript REPL for multi-step orchestration. Both paths go through the
 * Host's ComputerService — the REPL adds no second authority.
 *
 * The Node REPL runs in a separate worker with persistent bindings. Aborting
 * an evaluation terminates that worker and cancels its bridge requests.
 * It is an execution facility, not an operating-system security sandbox.
 */

const ComputerParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("prepare"),
    Type.Literal("start"),
    Type.Literal("stop"),
    Type.Literal("artifact"),
    Type.Literal("apps"),
    Type.Literal("observe"),
    Type.Literal("act"),
    Type.Literal("cancel"),
    Type.Literal("release"),
    Type.Literal("run"),
    Type.Literal("reset"),
    Type.Literal("environment"),
  ]),
  /** Target desktop; omit for the work's environment binding or the configured default. */
  desktopId: Type.Optional(Type.String()),
  /** environment: managed execution target for this work's shell/process ops; "" or null clears back to this Host. */
  workTarget: Type.Optional(Type.String()),
  /** environment: also clear the work's desktop binding when true. */
  clear: Type.Optional(Type.Boolean()),
  connectionId: Type.Optional(Type.String({ description: "prepare: saved Host connection id; omit for this Host." })),
  width: Type.Optional(Type.Integer({ minimum: 1 })),
  height: Type.Optional(Type.Integer({ minimum: 1 })),
  relativePath: Type.Optional(Type.String({ description: "artifact: file path relative to the managed desktop user's home." })),
  /** observe/act/apps: app selector (process name, window title, or pid). */
  app: Type.Optional(Type.String()),
  /** observe: which of the app's windows to bind — hwnd number or title (multi-window apps). */
  window: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
  /** observe: include a PNG screenshot of the window. */
  includeScreenshot: Type.Optional(Type.Boolean()),
  /** observe: cap the textual tree dump (number of lines, or "max"). */
  textLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("max")])),
  /** act: the structured action object. */
  operation: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** run: JavaScript evaluated in the session-persistent context. */
  script: Type.Optional(Type.String()),
  /** run: optional evaluation budget; cancellation is always supported. */
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const errorResult = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? "failed";
  const uncertainEffect = code === "timeout" || /abort|budget exhausted/i.test(message);
  return {
    content: [{ type: "text" as const, text: `computer failed (${code}): ${message}${uncertainEffect
      ? ". A submitted GUI action may have partly reached the desktop; observe before retrying."
      : ""}` }],
    isError: true as const,
    details: { code },
  };
};

const summarizeObservation = (observation: ComputerObservation): string => {
  const lines: string[] = [
    `observation ${observation.id} · desktop ${observation.desktopId} · app ${observation.app.name}${observation.app.windowTitle ? ` — ${observation.app.windowTitle}` : ""}`,
  ];
  if (observation.windowBounds) {
    const b = observation.windowBounds;
    lines.push(`window: ${b.width}×${b.height} @ (${b.x}, ${b.y})${observation.windowHandle !== undefined ? ` · hwnd ${observation.windowHandle}` : ""}${observation.dpiScale !== undefined ? ` · dpi ×${observation.dpiScale}` : ""}`);
  }
  if (observation.windows && observation.windows.length > 1) {
    lines.push(`windows: ${observation.windows.map((w) => `${w.handle}${w.main ? "*" : ""}${w.title ? ` "${w.title}"` : ""}`).join(", ")}`);
  }
  if (observation.focusedSummary) lines.push(`focused: ${observation.focusedSummary}`);
  if (observation.treeLines.length) lines.push(...observation.treeLines);
  if (observation.screenshot) lines.push(`[screenshot attached: ${observation.screenshot.width ?? "?"}×${observation.screenshot.height ?? "?"}, ${observation.screenshot.base64.length} b64 chars]`);
  return lines.join("\n");
};

export function createComputerTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  const repl = new ComputerRepl();
  const evaluations = new Set<AbortController>();

  return defineTool({
    name: "computer",
    label: "Computer",
    description: "Observe and operate real desktop applications: list computers/desktops, read the accessibility tree, click, type, press keys, scroll, drag — or run a persistent JavaScript REPL for multi-step GUI orchestration",
    promptSnippet: "computer: observe and operate desktop apps (list/apps/observe/act/cancel/run scripts)",
    promptGuidelines: [
      "Always observe before acting: element indexes are only valid for the observation that produced them — pass that observationId to act.",
      "act reports driver acceptance, not business completion; observe again to verify the UI changed.",
      "For sequences (fill a form, navigate a wizard) prefer action=run with a script over many round trips; bindings persist across run calls.",
      "In run scripts, top-level await and lexical declarations work; the last expression is the result (e.g. `const obs = await computer.observe('app'); obs.id`). Cancellation clears the script bindings.",
      "Use await computer.emitImage(obs) to show an observation screenshot to the model. A script batch is invalidated by desktop cancellation or human handoff; start a new run after observing the current scene.",
      "cancel drops queued input; release frees held keys/buttons. Use them when a gesture must not continue.",
      "If the tool reports the desktop unavailable or unprobed, report that honestly — never claim a GUI action happened.",
      "prepare installs a persistent Linux desktop and browser on this Host or a saved connection. Use it when an independent desktop is needed. start/stop require its desktopId; stopping closes applications but retains their saved files and browser profile.",
      "After saving a file in a managed desktop, action=artifact with its path relative to that desktop user's home records the exact file revision on the current work. The work view provides a download; a changed file must be registered again.",
      "action=environment reads or rebinds this work's execution environment (work target for shell ops, desktop for GUI ops). Operations already accepted keep their target; a rebind is never a file or session migration.",
    ],
    parameters: ComputerParams,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const desktop = params.desktopId?.trim() || undefined;
        switch (params.action) {
          case "prepare": {
            const result = await bridge.request("computer.prepare", {
              ...(params.connectionId ? { connectionId: params.connectionId } : {}),
              ...(params.width !== undefined ? { width: params.width } : {}),
              ...(params.height !== undefined ? { height: params.height } : {}),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "start":
          case "stop": {
            if (!desktop) throw new HarnessRequestError("invalid-params", "Desktop lifecycle requires desktopId");
            const result = await bridge.request("computer.desktopLifecycle", { desktopId: desktop, action: params.action });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "artifact": {
            if (!params.relativePath?.trim()) throw new HarnessRequestError("invalid-params", "artifact requires relativePath");
            const result = await bridge.request("computer.artifact", { relativePath: params.relativePath,
              ...(desktop ? { desktopId: desktop } : {}) });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "list": {
            const result = await bridge.request<"computer.list">("computer.list", {}) as ComputerListResult;
            const lines = [
              ...result.machines.map((m) => `machine ${m.id} "${m.name}" (${m.platform}, ${m.status})${m.provider === "remote" ? ` · prepare connectionId ${m.id.slice("remote:".length)}` : ""}`),
              ...result.desktops.map((d) => `desktop ${d.id} "${d.label}" on ${d.machineId} (${d.status}${d.statusDetail ? `: ${d.statusDetail}` : ""})`),
            ];
            return {
              content: [{ type: "text", text: lines.length ? lines.join("\n") : "no computers or desktops registered" }],
              details: result as unknown as Record<string, unknown>,
            };
          }
          case "apps": {
            const result = await bridge.request<"computer.apps">("computer.apps", {
              ...(desktop ? { desktopId: desktop } : {}),
            }) as ComputerAppsResult;
            const lines = result.apps.map((a) => {
              const windows = a.windows?.length ? ` · windows: ${a.windows.map((w) => `${w.handle}${w.main ? "*" : ""}${w.title ? ` "${w.title}"` : ""}`).join(", ")}` : "";
              return `${a.name} (pid ${a.pid})${a.windowTitle ? ` — ${a.windowTitle}` : ""}${windows}`;
            });
            return {
              content: [{ type: "text", text: lines.length ? lines.join("\n") : "no windows visible on this desktop" }],
              details: result as unknown as Record<string, unknown>,
            };
          }
          case "observe": {
            if (!params.app?.trim()) {
              return errorResult(new HarnessRequestError("invalid-params", "observe requires app (process name, window title, or pid)"));
            }
            const result = await bridge.request<"computer.observe">("computer.observe", {
              app: params.app,
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.window !== undefined ? { window: params.window } : {}),
              ...(params.includeScreenshot !== undefined ? { includeScreenshot: params.includeScreenshot } : {}),
              ...(params.textLimit !== undefined ? { textLimit: params.textLimit } : {}),
            }, signal ? { signal } : undefined) as ComputerObserveResult;
            const observation = result.observation;
            const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
              { type: "text", text: summarizeObservation(observation) },
            ];
            if (observation.screenshot) {
              blocks.push({ type: "image", data: observation.screenshot.base64, mimeType: observation.screenshot.mime });
            }
            return {
              content: blocks,
              details: { observationId: observation.id, elements: observation.elements, desktopId: observation.desktopId },
            };
          }
          case "act": {
            const operation = params.operation as ComputerAction | undefined;
            if (!operation?.kind || !operation.app) {
              return errorResult(new HarnessRequestError("invalid-params", "act requires operation.kind and operation.app"));
            }
            const result = await bridge.request<"computer.act">("computer.act", {
              action: operation,
              ...(desktop ? { desktopId: desktop } : {}),
            }, signal ? { signal } : undefined) as ComputerActResult;
            const r = result.result;
            const text = r.outcome === "unknown"
              ? `action outcome unknown: ${r.detail ?? "driver response lost"}. Observe the actual state before deciding whether to retry.`
              : r.outcome === "partial"
                ? `action cancelled mid-operation: ${r.detail ?? "part of the input already reached the desktop"}. Observe before continuing.`
                : r.cancelled
              ? `${r.accepted ? "input was dispatched before cancellation; observe its effect" : "action cancelled before dispatch"}${r.detail ? `: ${r.detail}` : ""}`
              : r.accepted
                ? `action dispatched${r.detail ? ` (${r.detail})` : ""} — observe to verify the effect`
                : `action rejected${r.detail ? `: ${r.detail}` : ""}`;
            const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
              { type: "text", text },
            ];
            if (r.observation?.screenshot) {
              blocks.push({ type: "image", data: r.observation.screenshot.base64, mimeType: r.observation.screenshot.mime });
            }
            return {
              content: blocks,
              ...(r.accepted ? {} : { isError: true as const }),
              details: { ...r, observationId: r.observation?.id },
            };
          }
          case "cancel": {
            for (const evaluation of evaluations) evaluation.abort(new Error("Computer evaluation cancelled"));
            const result = await bridge.request<"computer.cancel">("computer.cancel", {
              ...(desktop ? { desktopId: desktop } : {}),
            }) as ComputerCancelResult;
            return {
              content: [{ type: "text", text: `dropped ${result.cancelled} queued action(s); ${result.released ? "held input released" : "input release was not confirmed; inspect the desktop"}` }],
              details: { cancelled: result.cancelled, released: result.released },
            };
          }
          case "release": {
            const result = await bridge.request<"computer.release">("computer.release", {
              ...(desktop ? { desktopId: desktop } : {}),
            }) as ComputerReleaseResult;
            return {
              content: [{ type: "text", text: result.released ? "held keys/buttons released" : "no held input" }],
              details: { released: result.released },
            };
          }
          case "run": {
            if (!params.script?.trim()) {
              return errorResult(new HarnessRequestError("invalid-params", "run requires script"));
            }
            const controller = new AbortController();
            evaluations.add(controller);
            const abort = () => controller.abort(signal?.reason ?? new Error("Computer script cancelled"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            const timer = params.timeoutMs === undefined ? undefined : setTimeout(() =>
              controller.abort(new Error(`Computer script budget exhausted after ${params.timeoutMs}ms; bindings cleared`)), params.timeoutMs);
            try {
              // Snapshot the configured target once per evaluation. A settings
              // change while the script awaits must not redirect its next click.
              const requestOptions = { signal: controller.signal };
              const initial = (await bridge.request("computer.control", desktop ? { desktopId: desktop } : {}, requestOptions)).control;
              const epochs = new Map([[initial.desktopId, initial.automationEpoch]]);
              const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
              const field = async (requested?: string) => {
                const id = requested ?? initial.desktopId;
                if (!epochs.has(id)) {
                  const control = (await bridge.request("computer.control", { desktopId: id }, requestOptions)).control;
                  epochs.set(id, control.automationEpoch);
                }
                return { desktopId: id };
              };
              const api = {
                list: () => bridge.request("computer.list", {}, requestOptions),
                apps: async (id?: string) => bridge.request("computer.apps", await field(id), requestOptions).then((r) => r.apps),
                observe: async (app: string, opts?: { desktopId?: string; window?: number | string; includeScreenshot?: boolean; textLimit?: number | "max" }) =>
                  bridge.request("computer.observe", { ...opts, ...await field(opts?.desktopId), app }, requestOptions).then((r) => r.observation),
                act: async (action: ComputerAction, opts?: { desktopId?: string }) => {
                  const target = await field(opts?.desktopId);
                  const result = (await bridge.request("computer.act", { ...target, action, automationEpoch: epochs.get(target.desktopId)! }, requestOptions)).result;
                  if (!result.accepted || result.cancelled || result.outcome) {
                    throw new Error(`Computer action did not complete normally (${result.outcome ?? (result.cancelled ? "cancelled" : "rejected")}): ${result.detail ?? "observe the desktop before continuing"}`);
                  }
                  return result;
                },
                cancel: async (id?: string) => bridge.request("computer.cancel", await field(id), requestOptions),
                release: async (id?: string) => bridge.request("computer.release", await field(id), requestOptions),
                emitImage: async (observation: ComputerObservation) => {
                  const screenshot = observation?.screenshot;
                  if (!screenshot || screenshot.mime !== "image/png" || typeof screenshot.base64 !== "string") throw new Error("emitImage requires an observation with a screenshot");
                  images.push({ type: "image", data: screenshot.base64, mimeType: screenshot.mime });
                },
              };
              const result = await repl.run(params.script, async (method, args) => {
                controller.signal.throwIfAborted();
                const fn = api[method as keyof typeof api] as (...values: unknown[]) => Promise<unknown>;
                if (!fn) throw new Error(`Unknown computer method: ${method}`);
                return fn(...args);
              }, controller.signal);
              const lines = [...result.logs, ...(result.value !== undefined ? [`⇒ ${result.value}`] : [])];
              return { content: [{ type: "text", text: lines.join("\n") || "(no output)" }, ...images], details: { logs: result.logs } };
            } finally {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              controller.abort(new Error("Computer evaluation ended"));
              evaluations.delete(controller);
            }
          }
          case "environment": {
            // get when nothing is provided; otherwise update this work's
            // placement binding. Accepted operations keep their target —
            // the change only affects ops admitted afterwards.
            const hasUpdate = params.workTarget !== undefined || params.desktopId !== undefined || params.clear === true;
            const result = hasUpdate
              ? await bridge.request("environment.set", {
                  ...(params.clear === true ? { workTarget: null, desktopId: null }
                    : {
                        ...(params.workTarget !== undefined ? { workTarget: params.workTarget || null } : {}),
                        ...(params.desktopId !== undefined ? { desktopId: params.desktopId || null } : {}),
                      }),
                })
              : await bridge.request("environment.get", {});
            const env = result.environment;
            const lines = [
              env
                ? `environment: work target ${env.workTarget ?? "this Host"} · desktop ${env.desktopId ?? "(configured default)"}`
                : "environment: no Thread binding — ops use Host defaults",
            ];
            const handoff = (result as { handoff?: string | null }).handoff;
            if (handoff) lines.push(handoff);
            return { content: [{ type: "text", text: lines.join("\n") }], details: result as unknown as Record<string, unknown> };
          }
          case "reset": {
            for (const evaluation of evaluations) evaluation.abort(new Error("Computer REPL reset"));
            repl.reset();
            return { content: [{ type: "text", text: "REPL context reset; bindings cleared" }], details: { reset: true } };
          }
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
