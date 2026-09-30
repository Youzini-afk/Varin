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
    Type.Literal("open"),
    Type.Literal("put"),
    Type.Literal("forward"),
    Type.Literal("forwards"),
    Type.Literal("forwardClose"),
    Type.Literal("install"),
    Type.Literal("browser"),
    Type.Literal("office"),
    Type.Literal("evidence"),
  ]),
  /** Target desktop; omit for the work's environment binding or the configured default. */
  desktopId: Type.Optional(Type.String()),
  /** environment: managed execution target for this work's shell/process ops; "" or null clears back to this Host. */
  workTarget: Type.Optional(Type.String()),
  /** environment: also clear the work's desktop binding when true. */
  clear: Type.Optional(Type.Boolean()),
  /** open: URL opened by the target machine's handlers (localhost is the target's own loopback). */
  url: Type.Optional(Type.String()),
  /** open: absolute path on the target machine opened with its default app. */
  path: Type.Optional(Type.String()),
  /** open: application/binary resolved on the target machine. */
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  /** put: file bytes (base64) written atomically into the managed desktop user's home. */
  contentBase64: Type.Optional(Type.String()),
  /** forward: port the service listens on at the target machine. */
  port: Type.Optional(Type.Number()),
  /** forward: address on the target machine (default its loopback); also the managed target id when set. */
  host: Type.Optional(Type.String()),
  /** forward: managed target the service runs on (default this work's workTarget or this Host). */
  target: Type.Optional(Type.String()),
  /** forwardClose: access id returned by forward/forwards. */
  forwardId: Type.Optional(Type.String()),
  /** install: recipe component groups from the environment manifest (e.g. "dev", "docs"). */
  groups: Type.Optional(Type.Array(Type.String())),
  /** install: explicit package names on top of any groups. */
  packages: Type.Optional(Type.Array(Type.String())),
  /** browser: status | launch | tabs | snapshot | act — ops on the visible Chromium session (CDP attach). */
  browserOp: Type.Optional(Type.String()),
  /** browser: tab to attach for snapshot/act (default first page). */
  tabId: Type.Optional(Type.String()),
  /** browser act: navigate(url) | evaluate(expression) | click(x,y) | type(text) | screenshot — viewport coords come from the snapshot/observe bounds. */
  browserAct: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** office: status | launch | docs | open | act — ops on the live LibreOffice instance (UNO attach; open docs keep unsaved state). */
  officeOp: Type.Optional(Type.String()),
  /** office open: file path on the target machine. */
  officePath: Type.Optional(Type.String()),
  /** office act: read/write {doc,sheet,range,values} | insert {doc,text} | save {doc}. */
  officeAct: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** evidence: review the durable step journal — seq/at/sessionId/lane/tool/op/target/outcome for each executed operation (identifiers only). */
  evidenceSince: Type.Optional(Type.Number()),
  evidenceLimit: Type.Optional(Type.Number()),
  evidenceSession: Type.Optional(Type.String()),
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
      "action=open starts a URL/path/app on the desktop's own machine — `localhost` URLs and file paths resolve on that machine, not yours. action=put writes one file into the managed desktop user's home and returns its revision; it is a one-shot copy, not a sync.",
      "action=forward opens a live service access path: for a managed remote target it returns a loopback URL valid ONLY on this Host (a forward dies with it, close it with action=forwardClose); for the local target it returns the service's own address. forwards lists live handles. A remote service's localhost is never your localhost.",
      "action=install adds software to the environment owning the bound desktop — recipe groups (`dev`, `docs`) or explicit package names. It reports the package layer's real result: `installed` means packages landed, not that a control interface exists.",
      "action=browser attaches the visible Chromium session on the target machine (CDP): browserOp=launch starts it on the persistent profile, tabs lists real tabs, snapshot returns the page accessibility tree, browserAct runs navigate/evaluate/click(x,y viewport)/type/screenshot in that same session — the tabs and login state a human sees are the ones you operate.",
      "action=office attaches the live LibreOffice instance on the target machine (UNO): officeOp=launch starts it, docs lists open documents with their modified state, officePath opens a file into that instance, officeAct does read/write (sheet,range,values)/insert(text)/save on an open document — the same document a human is editing, unsaved state included.",
      "action=evidence reviews the desktop's durable operation journal (seq/at/sessionId/tool/op/target/outcome, identifiers only) — use it when a result mismatches, an action may have failed, or a response was lost, before deciding what actually happened. Diagnosis is a hypothesis until a later op confirms it; once a fix is verified against the real scene, memory remember can keep it as an experience with its trigger condition.",
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
                open: async (opts: { url?: string; path?: string; command?: string; args?: string[]; desktopId?: string }) => {
                  const { desktopId, ...rest } = opts;
                  const target = await field(desktopId);
                  const result = (await bridge.request("computer.open", { ...rest, ...target }, requestOptions)) as { accepted?: boolean; cancelled?: boolean; outcome?: string; detail?: string; pid?: number };
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
            const result = await bridge.request("computer.open", {
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
            const result = await bridge.request("computer.fileWrite", {
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
            const result = await bridge.request("environment.forward", {
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
            const result = await bridge.request("environment.forwards", {});
            return { content: [{ type: "text", text: JSON.stringify(result.accesses, null, 2) }], details: result as unknown as Record<string, unknown> };
          }
          case "forwardClose": {
            if (!params.forwardId?.trim()) return errorResult(new HarnessRequestError("invalid-params", "forwardClose requires forwardId"));
            const result = await bridge.request("environment.forwardClose", { id: params.forwardId });
            return { content: [{ type: "text", text: result.closed ? "forward closed" : "no live forward with that id" }], details: result as unknown as Record<string, unknown> };
          }
          case "install": {
            const groups = params.groups?.filter((g) => g.trim()) ?? [];
            const packages = params.packages?.filter((p) => p.trim()) ?? [];
            if (groups.length === 0 && packages.length === 0) {
              return errorResult(new HarnessRequestError("invalid-params", "install requires groups or packages"));
            }
            const result = await bridge.request("computer.installSoftware", {
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
            const result = await bridge.request("computer.browser", {
              op,
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.tabId ? { tabId: params.tabId } : {}),
              ...(params.browserAct !== undefined ? { act: params.browserAct as import("@varin/protocol").ComputerBrowserAct } : {}),
            });
            const r = result as { ok?: boolean; outcome?: string; status?: { running?: boolean; browser?: string };
              tabs?: Array<{ id: string; title?: string; url?: string }>; lines?: string[];
              result?: unknown; error?: string; image?: string };
            if (r.outcome === "unknown") {
              return errorResult(new HarnessRequestError("unavailable", `browser op may have reached the target — verify page state before retrying (${r.error ?? "response lost"})`));
            }
            const text = op === "status" || op === "launch"
              ? (r.status?.running ? `browser running${r.status.browser ? `: ${r.status.browser}` : ""}` : "browser not running")
              : op === "tabs"
                ? (r.tabs ?? []).map((t) => `${t.id} ${t.title ?? ""} ${t.url ?? ""}`).join("\n") || "no tabs"
                : op === "snapshot"
                  ? (r.lines ?? []).slice(0, 200).join("\n") || "empty snapshot"
                  : op === "act" && (params.browserAct as { kind?: string })?.kind === "screenshot"
                    ? "frame captured (see details.image)"
                    : r.error ?? (r.result !== undefined ? JSON.stringify(r.result) : "ok");
            return { content: [{ type: "text", text }], ...(r.ok === false ? { isError: true as const } : {}), details: result as unknown as Record<string, unknown> };
          }
          case "office": {
            const op = (params.officeOp ?? "status").trim() as import("@varin/protocol").ComputerOfficeOp;
            const result = await bridge.request("computer.office", {
              op,
              ...(desktop ? { desktopId: desktop } : {}),
              ...(params.officePath ? { path: params.officePath } : {}),
              ...(params.officeAct !== undefined ? { act: params.officeAct as import("@varin/protocol").ComputerOfficeAct } : {}),
            });
            const r = result as { ok?: boolean; outcome?: string; status?: { running?: boolean };
              docs?: Array<{ title?: string; kind?: string; modified?: boolean; url?: string | null }>;
              doc?: { title?: string; url?: string | null; modified?: boolean };
              sheet?: string; range?: string; values?: unknown[][]; modified?: boolean; error?: string };
            if (r.outcome === "unknown") {
              return errorResult(new HarnessRequestError("unavailable", `office op may have reached the target — verify document state before retrying (${r.error ?? "response lost"})`));
            }
            const text = op === "status" || op === "launch"
              ? (r.status?.running ? "LibreOffice running" : "LibreOffice not running")
              : op === "docs"
                ? (r.docs ?? []).map((d) => `${d.title ?? "(untitled)"} [${d.kind ?? "doc"}]${d.modified ? " (modified)" : ""} ${d.url ?? ""}`).join("\n") || "no open documents"
                : op === "open"
                  ? `opened ${r.doc?.title ?? ""}${r.doc?.url ? ` ${r.doc.url}` : ""}`
                  : op === "act" && (params.officeAct as { kind?: string })?.kind === "read"
                    ? JSON.stringify(r.values ?? [])
                    : r.error ?? `ok${r.modified === true ? " (modified)" : ""}`;
            return { content: [{ type: "text", text }], ...(r.ok === false ? { isError: true as const } : {}), details: result as unknown as Record<string, unknown> };
          }
          case "evidence": {
            const result = await bridge.request("computer.evidence", {
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
