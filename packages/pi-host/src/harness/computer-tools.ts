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

const ComputerOperation = Type.Object({
  kind: Type.Union(["click", "type", "key", "scroll", "drag", "set_value", "secondary"].map((kind) => Type.Literal(kind))),
  app: Type.String({ description: "Process name, window title substring, or pid" }),
  window: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "Native window handle or title within the app" })),
  observationId: Type.Optional(Type.String({ description: "Observation supplying elementIndex or coordinates; stale observations are rejected" })),
  elementIndex: Type.Optional(Type.Integer({ description: "Element index from observationId" })),
  x: Type.Optional(Type.Number({ description: "Window-relative pointer x coordinate" })),
  y: Type.Optional(Type.Number({ description: "Window-relative pointer y coordinate" })),
  fromX: Type.Optional(Type.Number({ description: "Drag start x in window coordinates" })),
  fromY: Type.Optional(Type.Number({ description: "Drag start y in window coordinates" })),
  toX: Type.Optional(Type.Number({ description: "Drag end x in window coordinates" })),
  toY: Type.Optional(Type.Number({ description: "Drag end y in window coordinates" })),
  clickCount: Type.Optional(Type.Number()),
  mouseButton: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  clickMethod: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("accessibility"), Type.Literal("app_post"), Type.Literal("global")])),
  direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
  pages: Type.Optional(Type.Number({ description: "scroll: number of pages" })),
  text: Type.Optional(Type.String({ description: "type: text to insert" })),
  key: Type.Optional(Type.String({ description: "key: chord such as enter, ctrl+s, or f5" })),
  value: Type.Optional(Type.String({ description: "set_value: replacement element value" })),
  action: Type.Optional(Type.String({ description: "secondary: name from the element's actions list" })),
}, { additionalProperties: true });

const BrowserOperation = Type.Object({
  kind: Type.Union(["navigate", "evaluate", "click", "type", "screenshot"].map((kind) => Type.Literal(kind))),
  url: Type.Optional(Type.String({ description: "navigate: destination URL on the target machine" })),
  expression: Type.Optional(Type.String({ description: "evaluate: JavaScript expression in the page" })),
  x: Type.Optional(Type.Number({ description: "click: CSS viewport x coordinate" })),
  y: Type.Optional(Type.Number({ description: "click: CSS viewport y coordinate" })),
  text: Type.Optional(Type.String({ description: "type: text to insert" })),
}, { additionalProperties: true });

const OfficeOperation = Type.Object({
  kind: Type.Union(["read", "write", "insert", "save", "export"].map((kind) => Type.Literal(kind))),
  doc: Type.Optional(Type.String({ description: "Open document id, unique title, or URL; defaults to the active document" })),
  sheet: Type.Optional(Type.String({ description: "read/write: sheet name; defaults to the first sheet" })),
  range: Type.Optional(Type.String({ description: "read/write: cell range, for example A1:B4" })),
  values: Type.Optional(Type.Array(Type.Array(Type.Unknown()), { description: "write: two-dimensional values matching the range" })),
  text: Type.Optional(Type.String({ description: "insert: text appended to the Writer document" })),
  path: Type.Optional(Type.String({ description: "save/export: destination path on the target machine" })),
  url: Type.Optional(Type.String({ description: "save/export: destination URL" })),
  filter: Type.Optional(Type.String({ description: "export: native filter name; defaults to the document kind's PDF filter" })),
}, { additionalProperties: true });

const ComputerParams = Type.Object({
  action: Type.Union([
    Type.Literal("list", { description: "List registered machines and desktops" }),
    Type.Literal("prepare", { description: "Install a persistent Linux desktop and browser on this Host or a saved connection" }),
    Type.Literal("start", { description: "Start desktopId" }),
    Type.Literal("stop", { description: "Stop desktopId; saved files and browser profile remain" }),
    Type.Literal("artifact", { description: "Register the current revision of a managed-home file for download" }),
    Type.Literal("apps", { description: "List visible applications and windows" }),
    Type.Literal("observe", { description: "Read an app's accessibility tree and optional screenshot" }),
    Type.Literal("act", { description: "Submit operation; acceptance identifies driver dispatch, not application completion" }),
    Type.Literal("cancel", { description: "Drop queued input and cancel active script evaluations" }),
    Type.Literal("release", { description: "Release held keys and pointer buttons" }),
    Type.Literal("run", { description: "Evaluate JavaScript with persistent bindings and the computer API" }),
    Type.Literal("reset", { description: "Clear the script context and bindings" }),
    Type.Literal("environment", { description: "Read or change this work's shell target and desktop binding; accepted operations retain their targets" }),
    Type.Literal("open", { description: "Open a URL, path, or application on the desktop's machine" }),
    Type.Literal("put", { description: "Write a file into the managed desktop user's home" }),
    Type.Literal("forward", { description: "Expose a target service on this Host; the returned local access path lasts while the forward is live" }),
    Type.Literal("forwards", { description: "List live service forwards" }),
    Type.Literal("forwardClose", { description: "Close forwardId" }),
    Type.Literal("install", { description: "Install recipe groups or packages in the desktop's environment" }),
    Type.Literal("browser", { description: "Operate the visible Chromium session through CDP" }),
    Type.Literal("office", { description: "Operate live LibreOffice documents, including unsaved state, through UNO" }),
    Type.Literal("evidence", { description: "Read the durable operation journal's identifiers and outcomes" }),
  ]),
  desktopId: Type.Optional(Type.String({ description: "Target desktop; defaults to the work's binding or configured default. Required for start/stop." })),
  workTarget: Type.Optional(Type.String({ description: "environment: managed shell target; empty string resets to this Host" })),
  clear: Type.Optional(Type.Boolean({ description: "environment: clear both the shell target and desktop binding" })),
  url: Type.Optional(Type.String({ description: "open: destination URL; localhost refers to the target machine" })),
  path: Type.Optional(Type.String({ description: "open: absolute path on the target machine" })),
  command: Type.Optional(Type.String({ description: "open: application executable on the target machine" })),
  args: Type.Optional(Type.Array(Type.String(), { description: "open: application arguments" })),
  contentBase64: Type.Optional(Type.String({ description: "put: base64 file bytes for an atomic write" })),
  port: Type.Optional(Type.Number({ description: "forward: service port on the target machine" })),
  host: Type.Optional(Type.String({ description: "forward: service address on the target machine; defaults to its loopback" })),
  target: Type.Optional(Type.String({ description: "forward: managed target id; defaults to the work's shell target or this Host" })),
  forwardId: Type.Optional(Type.String({ description: "forwardClose: id returned by forward/forwards" })),
  groups: Type.Optional(Type.Array(Type.String(), { description: "install: recipe groups such as dev or docs" })),
  packages: Type.Optional(Type.Array(Type.String(), { description: "install: explicit package names" })),
  browserOp: Type.Optional(Type.Union(["status", "launch", "tabs", "snapshot", "act"].map((op) => Type.Literal(op)), { description: "browser operation; defaults to status" })),
  tabId: Type.Optional(Type.String({ description: "browser snapshot/act: page id; optional only when exactly one page is open" })),
  browserBinary: Type.Optional(Type.String({ description: "browser launch: executable on the target machine" })),
  browserProfile: Type.Optional(Type.String({ description: "browser launch: persistent profile directory on the target machine" })),
  browserPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "browser: explicit CDP port" })),
  browserLimit: Type.Optional(Type.Integer({ minimum: 1, description: "browser snapshot: accessibility-tree line limit" })),
  browserAct: Type.Optional(BrowserOperation),
  officeOp: Type.Optional(Type.Union(["status", "launch", "docs", "open", "act"].map((op) => Type.Literal(op)), { description: "office operation; defaults to status" })),
  officePath: Type.Optional(Type.String({ description: "office open: path on the target machine" })),
  officeUrl: Type.Optional(Type.String({ description: "office open: URL on the target machine" })),
  officeAct: Type.Optional(OfficeOperation),
  evidenceSince: Type.Optional(Type.Number({ description: "evidence: return entries after this sequence number" })),
  evidenceLimit: Type.Optional(Type.Number({ description: "evidence: maximum number of journal entries" })),
  evidenceSession: Type.Optional(Type.String({ description: "evidence: filter by session id" })),
  connectionId: Type.Optional(Type.String({ description: "prepare: saved Host connection id; omit for this Host" })),
  width: Type.Optional(Type.Integer({ minimum: 1, description: "prepare: desktop width in pixels" })),
  height: Type.Optional(Type.Integer({ minimum: 1, description: "prepare: desktop height in pixels" })),
  relativePath: Type.Optional(Type.String({ description: "artifact/put: file path relative to the managed desktop user's home" })),
  app: Type.Optional(Type.String({ description: "observe: process name, window title, or pid" })),
  window: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "observe: native window handle or title" })),
  includeScreenshot: Type.Optional(Type.Boolean({ description: "observe: attach a PNG screenshot" })),
  textLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("max")], { description: "observe: maximum accessibility-tree lines" })),
  operation: Type.Optional(ComputerOperation),
  script: Type.Optional(Type.String({ description: "run: JavaScript with top-level await; the last expression is returned. Example: const obs = await computer.observe('app'); await computer.emitImage(obs); obs.id" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "run: evaluation budget in milliseconds; cancellation clears bindings" })),
});

const errorResult = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? "failed";
  const uncertainEffect = code === "timeout" || /abort|budget exhausted/i.test(message);
  return {
    content: [{ type: "text" as const, text: `computer failed (${code}): ${message}${uncertainEffect
      ? ". A submitted GUI action may have partly reached the desktop."
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
      "Element indexes and coordinates bind to observationId; the Host rejects stale observations. act reports driver acceptance, and uncertain or partial outcomes remain explicit.",
      "run supports top-level await, lexical bindings, and computer.list/apps/observe/act/open/browser/office/evidence/cancel/release. computer.emitImage(observation) attaches its screenshot. Bindings persist until reset or evaluation cancellation; desktop handoff invalidates the evaluation.",
      "Browser actions use CSS viewport coordinates; desktop actions use window-relative coordinates. URLs, files, and localhost resolve on the target machine.",
    ],
    parameters: ComputerParams,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const request: HostServicesBridge["request"] = (method, values, options) => {
        const operationSignal = options?.signal ?? signal;
        return bridge.request(method, values, {
          ...(method === "computer.installSoftware" ? { timeoutMs: 0 } : {}), ...options,
          ...(operationSignal ? { signal: operationSignal } : {}),
        });
      };
      try {
        const desktop = params.desktopId?.trim() || undefined;
        switch (params.action) {
          case "prepare": {
            const result = await request("computer.prepare", {
              ...(params.connectionId ? { connectionId: params.connectionId } : {}),
              ...(params.width !== undefined ? { width: params.width } : {}),
              ...(params.height !== undefined ? { height: params.height } : {}),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "start":
          case "stop": {
            if (!desktop) throw new HarnessRequestError("invalid-params", "Desktop lifecycle requires desktopId");
            const result = await request("computer.desktopLifecycle", { desktopId: desktop, action: params.action });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "artifact": {
            if (!params.relativePath?.trim()) throw new HarnessRequestError("invalid-params", "artifact requires relativePath");
            const result = await request("computer.artifact", { relativePath: params.relativePath,
              ...(desktop ? { desktopId: desktop } : {}) });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          case "list": {
            const result = await request<"computer.list">("computer.list", {}) as ComputerListResult;
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
            const result = await request<"computer.apps">("computer.apps", {
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
            const result = await request<"computer.observe">("computer.observe", {
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
            const result = await request<"computer.act">("computer.act", {
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
                ? `action dispatched${r.detail ? ` (${r.detail})` : ""} — driver acceptance; application completion is not confirmed`
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
            const result = await request<"computer.cancel">("computer.cancel", {
              ...(desktop ? { desktopId: desktop } : {}),
            }) as ComputerCancelResult;
            return {
              content: [{ type: "text", text: `dropped ${result.cancelled} queued action(s); ${result.released ? "held input released" : "input release was not confirmed; inspect the desktop"}` }],
              details: { cancelled: result.cancelled, released: result.released },
            };
          }
          case "release": {
            const result = await request<"computer.release">("computer.release", {
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
              const initial = (await request("computer.control", desktop ? { desktopId: desktop } : {}, requestOptions)).control;
              const epochs = new Map([[initial.desktopId, initial.automationEpoch]]);
              const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
              const field = async (requested?: string) => {
                const id = requested ?? initial.desktopId;
                if (!epochs.has(id)) {
                  const control = (await request("computer.control", { desktopId: id }, requestOptions)).control;
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
                  const result = (await request("computer.act", { ...target, action, automationEpoch: epochs.get(target.desktopId)! }, requestOptions)).result;
                  if (!result.accepted || result.cancelled || result.outcome) {
                    throw new Error(`Computer action did not complete normally (${result.outcome ?? (result.cancelled ? "cancelled" : "rejected")}): ${result.detail ?? "observe the desktop before continuing"}`);
                  }
                  return result;
                },
                cancel: async (id?: string) => bridge.request("computer.cancel", await field(id), requestOptions),
                release: async (id?: string) => bridge.request("computer.release", await field(id), requestOptions),
                open: async (opts: { url?: string; path?: string; command?: string; args?: string[]; desktopId?: string }) => {
                  const { desktopId, ...rest } = opts;
                  const target = await field(desktopId);
                  const result = (await request("computer.open", { ...rest, ...target, automationEpoch: epochs.get(target.desktopId)! }, requestOptions)) as { accepted?: boolean; cancelled?: boolean; outcome?: string; detail?: string; pid?: number };
                  if (!result.accepted || result.cancelled || result.outcome) {
                    throw new Error(`Computer open did not complete normally (${result.outcome ?? (result.cancelled ? "cancelled" : "rejected")}): ${result.detail ?? "check the desktop"}`);
                  }
                  return result;
                },
                emitImage: async (observation: ComputerObservation) => {
                  const screenshot = observation?.screenshot;
                  if (!screenshot || screenshot.mime !== "image/png" || typeof screenshot.base64 !== "string") throw new Error("emitImage requires an observation with a screenshot");
                  images.push({ type: "image", data: screenshot.base64, mimeType: screenshot.mime });
                },
                browser: async (opts: import('@varin/protocol').ComputerBrowserParams) => {
                  const target = await field(opts.desktopId);
                  const result = await request('computer.browser', { ...opts, ...target, automationEpoch: epochs.get(target.desktopId)! }, requestOptions);
                  if (!result.ok || result.cancelled || result.outcome) throw new Error(`Browser operation did not complete normally: ${result.error ?? result.outcome ?? 'cancelled'}`);
                  return result;
                },
                office: async (opts: import('@varin/protocol').ComputerOfficeParams) => {
                  const target = await field(opts.desktopId);
                  const result = await request('computer.office', { ...opts, ...target, automationEpoch: epochs.get(target.desktopId)! }, requestOptions);
                  if (!result.ok || result.cancelled || result.outcome) throw new Error(`Office operation did not complete normally: ${result.error ?? result.outcome ?? 'cancelled'}`);
                  return result;
                },
                evidence: async (opts: import('@varin/protocol').ComputerEvidenceParams = {}) =>
                  request('computer.evidence', { ...opts, ...await field(opts.desktopId) }, requestOptions),
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
          case "open": {
            const result = await request("computer.open", {
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.url !== undefined ? { url: params.url } : {}),
              ...(params.path !== undefined ? { path: params.path } : {}),
              ...(params.command !== undefined ? { command: params.command } : {}),
              ...(params.args !== undefined ? { args: params.args } : {}),
            });
            const r = result as { accepted?: boolean; pid?: number; detail?: string; outcome?: string; cancelled?: boolean };
            const text = r.outcome === "unknown"
              ? `open outcome unknown: ${r.detail ?? "response lost"}. Check the desktop before retrying.`
              : r.accepted
                ? `opened on the desktop${r.pid !== undefined ? ` (pid ${r.pid})` : ""}${r.cancelled ? " — cancelled after dispatch; verify what launched" : ""}`
                : `open rejected${r.detail ? `: ${r.detail}` : ""}`;
            return { content: [{ type: "text", text }], ...(r.accepted ? {} : { isError: true as const }), details: r as Record<string, unknown> };
          }
          case "put": {
            if (!params.relativePath?.trim()) return errorResult(new HarnessRequestError("invalid-params", "put requires relativePath"));
            if (typeof params.contentBase64 !== "string") return errorResult(new HarnessRequestError("invalid-params", "put requires contentBase64"));
            const result = await request("computer.fileWrite", {
              relativePath: params.relativePath,
              contentBase64: params.contentBase64,
              ...(desktop ? { desktopId: desktop } : {}),
            });
            const v = result.version as { sha256: string; byteLength: number };
            return { content: [{ type: "text", text: `wrote ${v.byteLength} bytes (sha256 ${v.sha256.slice(0, 12)}…) — one-shot copy, not a sync` }], details: result as unknown as Record<string, unknown> };
          }
          case "forward": {
            if (!Number.isSafeInteger(params.port) || params.port! < 1 || params.port! > 65535) {
              return errorResult(new HarnessRequestError("invalid-params", "forward requires port (1-65535)"));
            }
            const result = await request("environment.forward", {
              port: params.port!,
              ...(params.host !== undefined ? { host: params.host } : {}),
              ...(params.target !== undefined ? { target: params.target } : {}),
            });
            const a = result.access;
            const where = a.access.kind === "forward"
              ? `reachable ONLY on this Host at ${a.access.url} (forward ${a.id}, live handle — dies with the Host)`
              : `reachable directly at ${a.access.url} on ${a.access.machineId}`;
            return { content: [{ type: "text", text: `service on ${a.service.machineId} ${a.service.host}:${a.service.port} — ${where}` }], details: result as unknown as Record<string, unknown> };
          }
          case "forwards": {
            const result = await request("environment.forwards", {});
            return { content: [{ type: "text", text: JSON.stringify(result.accesses, null, 2) }], details: result as unknown as Record<string, unknown> };
          }
          case "forwardClose": {
            if (!params.forwardId?.trim()) return errorResult(new HarnessRequestError("invalid-params", "forwardClose requires forwardId"));
            const result = await request("environment.forwardClose", { id: params.forwardId });
            return { content: [{ type: "text", text: result.closed ? "forward closed" : "no live forward with that id" }], details: result as unknown as Record<string, unknown> };
          }
          case "install": {
            const groups = params.groups?.filter((g) => g.trim()) ?? [];
            const packages = params.packages?.filter((p) => p.trim()) ?? [];
            if (groups.length === 0 && packages.length === 0) {
              return errorResult(new HarnessRequestError("invalid-params", "install requires groups or packages"));
            }
            const result = await request("computer.installSoftware", {
              ...(groups.length ? { groups } : {}),
              ...(packages.length ? { packages } : {}),
              ...(desktop ? { desktopId: desktop } : {}),
            });
            const results = result.results as Array<{ id: string; state: string; detail?: string }>;
            const failed = results.filter((r) => r.state !== "installed");
            const text = results.map((r) => `${r.id}: ${r.state}${r.detail ? ` (${r.detail})` : ""}`).join("; ")
              + (failed.length ? " — failed entries stay on the desktop's software record" : " — persisted on the desktop's software record");
            return { content: [{ type: "text", text }], ...(failed.length ? { isError: true as const } : {}), details: result as unknown as Record<string, unknown> };
          }
          case "browser": {
            const op = (params.browserOp ?? "status").trim() as import("@varin/protocol").ComputerBrowserOp;
            const result = await request("computer.browser", {
              op,
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.tabId ? { tabId: params.tabId } : {}),
              ...(params.browserBinary ? { binary: params.browserBinary } : {}),
              ...(params.browserProfile ? { profile: params.browserProfile } : {}),
              ...(params.browserPort !== undefined ? { port: params.browserPort } : {}),
              ...(params.browserLimit !== undefined ? { limit: params.browserLimit } : {}),
              ...(params.browserAct !== undefined ? { act: params.browserAct as import("@varin/protocol").ComputerBrowserAct } : {}),
            });
            const r = result;
            if (r.outcome === "unknown") {
              return errorResult(new HarnessRequestError("unavailable", `browser op may have reached the target — verify page state before retrying (${r.error ?? "response lost"})`));
            }
            const text = op === "status" || op === "launch"
              ? (r.status?.running ? `browser interface connected${r.status.browser ? `: ${r.status.browser}` : ""}` : `browser interface unavailable${r.status?.detail ? `: ${r.status.detail}` : ""}`)
              : op === "tabs"
                ? (r.tabs ?? []).map((t) => `${t.id} ${t.title ?? ""} ${t.url ?? ""}`).join("\n") || "no tabs"
                : op === "snapshot"
                  ? `${(r.lines ?? []).join("\n") || "empty snapshot"}${r.truncated ? "\n[more AX nodes omitted; request a larger limit or inspect a specific tab]" : ""}`
                  : op === "act" && (params.browserAct as { kind?: string })?.kind === "screenshot"
                    ? "frame captured (see details.image)"
                    : r.error ?? (r.result !== undefined ? JSON.stringify(r.result) : "ok");
            const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: r.ok === false ? r.error ?? text : text }];
            const frame = r.image?.match(/^data:(image\/[^;]+);base64,(.+)$/u);
            if (frame) blocks.push({ type: 'image', data: frame[2]!, mimeType: frame[1]! });
            return { content: blocks, ...(r.ok === false || r.cancelled ? { isError: true as const } : {}), details: result as unknown as Record<string, unknown> };
          }
          case "office": {
            const op = (params.officeOp ?? "status").trim() as import("@varin/protocol").ComputerOfficeOp;
            const result = await request("computer.office", {
              op,
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.officePath ? { path: params.officePath } : {}),
              ...(params.officeUrl ? { url: params.officeUrl } : {}),
              ...(params.officeAct !== undefined ? { act: params.officeAct as import("@varin/protocol").ComputerOfficeAct } : {}),
            });
            const r = result;
            if (r.outcome === "unknown") {
              return errorResult(new HarnessRequestError("unavailable", `office op may have reached the target — verify document state before retrying (${r.error ?? "response lost"})`));
            }
            const text = op === "status" || op === "launch"
              ? (r.status?.running ? "LibreOffice interface connected" : `LibreOffice interface unavailable${r.status?.detail ? `: ${r.status.detail}` : ""}`)
              : op === "docs"
                ? (r.docs ?? []).map((d) => `${d.id ?? ""} ${d.title ?? "(untitled)"} [${d.kind ?? "doc"}]${d.modified ? " (modified)" : ""} ${d.url ?? ""}`).join("\n") || "no open documents"
                : op === "open"
                  ? `opened ${r.doc?.title ?? ""}${r.doc?.url ? ` ${r.doc.url}` : ""}`
                  : op === "act" && (params.officeAct as { kind?: string })?.kind === "read"
                    ? r.text ?? JSON.stringify(r.values ?? [])
                    : r.error ?? `ok${r.modified === true ? " (modified)" : ""}`;
            return { content: [{ type: "text", text: r.ok === false ? r.error ?? text : text }], ...(r.ok === false || r.cancelled ? { isError: true as const } : {}), details: result as unknown as Record<string, unknown> };
          }
          case "evidence": {
            const result = await request("computer.evidence", {
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.evidenceSession !== undefined ? { sessionId: params.evidenceSession } : {}),
              ...(params.evidenceSince !== undefined ? { since: params.evidenceSince } : {}),
              ...(params.evidenceLimit !== undefined ? { limit: params.evidenceLimit } : {}),
            });
            const r = result as { entries?: Array<{ seq?: number; at?: string; sessionId?: string; lane?: string;
              tool?: string; op?: string; target?: string; outcome?: string; error?: string; observationId?: string }> };
            const lines = (r.entries ?? []).map((e) =>
              `#${e.seq ?? "?"} ${e.at ?? ""} ${e.tool ?? ""}${e.op ? `/${e.op}` : ""}${e.target ? ` ${e.target}` : ""} → ${e.outcome ?? "?"}${e.error ? ` (${e.error})` : ""}${e.sessionId ? ` [session ${e.sessionId}]` : ""}`);
            return { content: [{ type: "text", text: lines.join("\n") || "no recorded steps" }], details: result as unknown as Record<string, unknown> };
          }
          case "environment": {
            // get when nothing is provided; otherwise update this work's
            // placement binding. Accepted operations keep their target —
            // the change only affects ops admitted afterwards.
            const hasUpdate = params.workTarget !== undefined || params.desktopId !== undefined || params.clear === true;
            const result = hasUpdate
              ? await request("environment.set", {
                  ...(params.clear === true ? { workTarget: null, desktopId: null }
                    : {
                        ...(params.workTarget !== undefined ? { workTarget: params.workTarget || null } : {}),
                        ...(params.desktopId !== undefined ? { desktopId: params.desktopId || null } : {}),
                      }),
                })
              : await request("environment.get", {});
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
