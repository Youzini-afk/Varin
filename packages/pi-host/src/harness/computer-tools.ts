import vm from "node:vm";
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
 * The REPL runs inside this Pi host process in a `node:vm` context (one per
 * session, so sequential script calls share bindings). It exposes only the
 * whitelisted `computer` API and `console` capture — no `process`, `require`,
 * or filesystem. Model-authored scripts never reach a renderer.
 */

const ComputerParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("apps"),
    Type.Literal("observe"),
    Type.Literal("act"),
    Type.Literal("cancel"),
    Type.Literal("release"),
    Type.Literal("run"),
    Type.Literal("reset"),
  ]),
  /** Target desktop; omit for the configured default. */
  desktopId: Type.Optional(Type.String()),
  /** observe/act/apps: app selector (process name, window title, or pid). */
  app: Type.Optional(Type.String()),
  /** observe: include a PNG screenshot of the window. */
  includeScreenshot: Type.Optional(Type.Boolean()),
  /** observe: cap the textual tree dump (number of lines, or "max"). */
  textLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("max")])),
  /** act: the structured action object. */
  operation: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** run: JavaScript evaluated in the session-persistent context. */
  script: Type.Optional(Type.String()),
  /** run: evaluation timeout in ms (default 30000, capped at 120000). */
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const errorResult = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? "failed";
  return {
    content: [{ type: "text" as const, text: `computer failed (${code}): ${message}` }],
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
    lines.push(`window: ${b.width}×${b.height} @ (${b.x}, ${b.y})`);
  }
  if (observation.focusedSummary) lines.push(`focused: ${observation.focusedSummary}`);
  if (observation.treeLines.length) lines.push(...observation.treeLines);
  if (observation.screenshot) lines.push(`[screenshot attached: ${observation.screenshot.width ?? "?"}×${observation.screenshot.height ?? "?"}, ${observation.screenshot.base64.length} b64 chars]`);
  return lines.join("\n");
};

/** One persistent REPL context per session — the tool closure owns it. */
interface SessionRepl {
  context: vm.Context;
  computer: Record<string, unknown>;
}

const createReplContext = (bridge: HostServicesBridge, defaultDesktopId?: string): SessionRepl => {
  const desktopField = (desktopId?: string): { desktopId: string } | Record<string, never> => {
    const id = desktopId ?? defaultDesktopId;
    return id ? { desktopId: id } : {};
  };
  const computer = {
    list: () => bridge.request<"computer.list">("computer.list", {}) as Promise<ComputerListResult>,
    apps: (desktopId?: string) =>
      bridge.request<"computer.apps">("computer.apps", desktopField(desktopId))
        .then((r) => (r as ComputerAppsResult).apps),
    observe: (app: string, opts?: { desktopId?: string; includeScreenshot?: boolean; textLimit?: number | "max" }) =>
      bridge.request<"computer.observe">("computer.observe", {
        app,
        ...desktopField(opts?.desktopId),
        ...(opts?.includeScreenshot !== undefined ? { includeScreenshot: opts.includeScreenshot } : {}),
        ...(opts?.textLimit !== undefined ? { textLimit: opts.textLimit } : {}),
      }).then((r) => (r as ComputerObserveResult).observation),
    act: (action: ComputerAction, opts?: { desktopId?: string }) =>
      bridge.request<"computer.act">("computer.act", {
        action,
        ...desktopField(opts?.desktopId),
      }).then((r) => (r as ComputerActResult).result),
    cancel: (desktopId?: string) =>
      bridge.request<"computer.cancel">("computer.cancel", desktopField(desktopId)) as Promise<ComputerCancelResult>,
    release: (desktopId?: string) =>
      bridge.request<"computer.release">("computer.release", desktopField(desktopId)) as Promise<ComputerReleaseResult>,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(ms, 0), 60000))),
  };
  const logs: string[] = [];
  const console_ = {
    log: (...args: unknown[]) => { logs.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); },
    warn: (...args: unknown[]) => { logs.push(`[warn] ${args.map(String).join(" ")}`); },
    error: (...args: unknown[]) => { logs.push(`[error] ${args.map(String).join(" ")}`); },
  };
  const context = vm.createContext(
    { computer, console: console_, sleep: computer.sleep },
    { name: "varin-computer-repl" },
  );
  // Expose the log buffer for the caller to drain after each evaluation.
  Object.defineProperty(computer, "__drainLogs", { value: () => logs.splice(0, logs.length), enumerable: false });
  return { context, computer };
};

export function createComputerTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  let repl: SessionRepl | null = null;
  const replFor = () => (repl ??= createReplContext(bridge));

  return defineTool({
    name: "computer",
    label: "Computer",
    description: "Observe and operate real desktop applications: list computers/desktops, read the accessibility tree, click, type, press keys, scroll, drag — or run a persistent JavaScript REPL for multi-step GUI orchestration",
    promptSnippet: "computer: observe and operate desktop apps (list/apps/observe/act/cancel/run scripts)",
    promptGuidelines: [
      "Always observe before acting: element indexes are only valid for the observation that produced them — pass that observationId to act.",
      "act reports driver acceptance, not business completion; observe again to verify the UI changed.",
      "For sequences (fill a form, navigate a wizard) prefer action=run with a script over many round trips; bindings persist across run calls.",
      "In run scripts, top-level await works; use `return` to surface a value (e.g. `return obs.id`) and console.log for progress.",
      "cancel drops queued input; release frees held keys/buttons. Use them when a gesture must not continue.",
      "If the tool reports the desktop unavailable or unprobed, report that honestly — never claim a GUI action happened.",
    ],
    parameters: ComputerParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const desktop = params.desktopId?.trim() || undefined;
        switch (params.action) {
          case "list": {
            const result = await bridge.request<"computer.list">("computer.list", {}) as ComputerListResult;
            const lines = [
              ...result.machines.map((m) => `machine ${m.id} "${m.name}" (${m.platform}, ${m.status})`),
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
            const lines = result.apps.map((a) => `${a.name} (pid ${a.pid})${a.windowTitle ? ` — ${a.windowTitle}` : ""}`);
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
              ...(params.includeScreenshot !== undefined ? { includeScreenshot: params.includeScreenshot } : {}),
              ...(params.textLimit !== undefined ? { textLimit: params.textLimit } : {}),
            }) as ComputerObserveResult;
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
            }) as ComputerActResult;
            const r = result.result;
            const text = r.cancelled
              ? `action cancelled before/while running${r.detail ? `: ${r.detail}` : ""}`
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
            const result = await bridge.request<"computer.cancel">("computer.cancel", {
              ...(desktop ? { desktopId: desktop } : {}),
            }) as ComputerCancelResult;
            return {
              content: [{ type: "text", text: result.cancelled > 0 ? `dropped ${result.cancelled} queued action(s); held input released` : "nothing queued; held input released" }],
              details: { cancelled: result.cancelled },
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
            const session = replFor();
            const timeout = Math.min(params.timeoutMs ?? 30000, 120000);
            let value: unknown;
            try {
              // Classic-script eval first: the completion value is the last
              // expression. `await` is a SyntaxError there — retry wrapped in
              // an async body where `return` surfaces the value.
              let evaluated: unknown;
              try {
                evaluated = vm.runInContext(params.script, session.context, { timeout, displayErrors: true });
              } catch (syntax) {
                // vm raises the *context's* SyntaxError — instanceof against
                // the host realm fails, so match by name.
                if ((syntax as Error)?.name !== "SyntaxError") throw syntax;
                // Async fallback: wrap in an async body for top-level await,
                // and hoist `const`/`let`/`var` declarations to context-global
                // assignments so bindings persist across `run` calls (the same
                // trick REPLs use). Functions must be assigned (`f = () =>…`)
                // or defined in a non-async classic eval to persist.
                const hoisted = params.script.replace(
                  /(^|\n)(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g,
                  "$1$2$3 =",
                );
                evaluated = vm.runInContext(
                  `(async () => {\n${hoisted}\n})()`,
                  session.context,
                  { timeout, displayErrors: true },
                );
              }
              // vm's own timeout only bounds synchronous evaluation; scripts
              // await driver calls, so race the returned promise too.
              value = await Promise.race([
                Promise.resolve(evaluated),
                new Promise<never>((_resolve, reject) => setTimeout(
                  () => reject(new Error(`script timed out after ${timeout}ms`)), timeout,
                )),
              ]);
            } catch (error) {
              const drained = (session.computer.__drainLogs as () => string[])();
              const text = [`script error: ${error instanceof Error ? error.message : String(error)}`];
              if (drained.length) text.push("", "console:", ...drained.map((l) => `  ${l}`));
              return { content: [{ type: "text", text: text.join("\n") }], isError: true as const, details: { code: "failed" } };
            }
            const drained = (session.computer.__drainLogs as () => string[])();
            const lines: string[] = [];
            if (drained.length) lines.push("console:", ...drained.map((l) => `  ${l}`));
            if (value !== undefined) {
              const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
              lines.push(`⇒ ${rendered?.slice(0, 8000) ?? "undefined"}`);
            }
            return {
              content: [{ type: "text", text: lines.length ? lines.join("\n") : "(no output)" }],
              details: { logs: drained },
            };
          }
          case "reset": {
            repl = null;
            return { content: [{ type: "text", text: "REPL context reset; bindings cleared" }], details: { reset: true } };
          }
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
