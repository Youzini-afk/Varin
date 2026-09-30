import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  FollowUpCheckResult,
  FollowUpGetResult,
  FollowUpListResult,
  FollowUpRegisterResult,
  FollowUpUpdateResult,
  HarnessMethod,
  HarnessServiceMap,
} from "@varin/protocol";

/**
 * Follow-up tool (D-307 / Stage W): register a durable wait + continuation on
 * this thread. The host watches the source (clock, experiment terminal state,
 * or an explicit trigger) and resumes THIS thread through the normal
 * Thread/Run lifecycle — no polling loop, no second session.
 *
 * Registration is non-blocking by default: the agent keeps working and the
 * trigger lands as an inform in the next request. `pause: true` is the
 * explicit "wait" — it marks the thread as waiting on the follow-up and
 * pauses the goal so automation stops auditing until the trigger resumes it.
 */

const errorResult = (toolName: string, error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error instanceof HarnessRequestError || (error as { code?: string }).code !== undefined)
    ? (error as { code: string }).code
    : "failed";
  return {
    content: [{ type: "text" as const, text: `${toolName} failed (${code}): ${message}` }],
    isError: true as const,
    details: { code },
  };
};

const invalidParams = (toolName: string, message: string): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => ({
  content: [{ type: "text" as const, text: `${toolName} failed (invalid-params): ${message}` }],
  isError: true as const,
  details: { code: "invalid-params" },
});

const describeSource = (source: Record<string, unknown>): string => {
  switch (source.kind) {
    case "time":
      return `at ${new Date(source.at as number).toISOString()}${typeof source.timezone === "string" ? ` (${source.timezone})` : ""}`;
    case "experiment":
      return `experiment attempt ${source.attemptId}${typeof source.fallbackAt === "number" ? `; check by ${new Date(source.fallbackAt).toISOString()} if still running` : ""}`;
    case "artifact":
      return `experiment attempt ${source.attemptId} artifact ${source.artifactId ?? source.name ?? "collection"}${source.every === true ? " (each)" : ""}`;
    case "file":
      return `workspace file ${source.path} ${source.condition}`;
    case "log":
      return `experiment attempt ${source.attemptId} ${source.stream ?? "stdout"} matching ${source.regex === true ? `/${source.pattern}/` : JSON.stringify(source.pattern)}`;
    case "metric":
      return `${source.metric} on ${source.machineId} ${source.predicate} ${source.threshold}${source.every === true ? " (each crossing)" : ""}`;
    case "external":
      return `GitHub PR ${source.condition}${typeof source.branch === "string" ? ` on ${source.branch}` : ""}`;
    case "shell":
      return source.condition === "output"
        ? `shell ${source.executionId} output matching ${source.regex === true ? `/${source.pattern}/` : JSON.stringify(source.pattern)}`
        : source.condition === "status"
          ? `shell ${source.executionId} status ${(source.states as string[] | undefined)?.join("/") ?? "terminal"}`
          : `shell ${source.executionId} to exit`;
    case "any":
    case "all":
      return `${source.kind} of ${((source.sources as Record<string, unknown>[] | undefined) ?? []).map(describeSource).join("; ")}${source.every === true ? " (repeatable edges)" : ""}`;
    case "desktop":
      return source.condition === "status"
        ? `desktop ${source.desktopId} status ${(source.states as string[] | undefined)?.join("/") ?? ""}${source.every === true ? " (each)" : ""}`
        : `desktop ${source.desktopId} file ${source.path ?? ""}${typeof source.sha256 === "string" ? ` different from ${source.sha256.slice(0, 12)}…` : " to appear"}${source.every === true ? " (each revision)" : ""}`;
    case "manual":
      return typeof source.note === "string" ? source.note : "explicit trigger only";
    default:
      return String(source.kind ?? "unknown");
  }
};

const describeView = (view: { id: string; status: string; waitingSummary?: string; revision: string }): string =>
  `${view.id} [${view.status}]${view.waitingSummary ? ` — ${view.waitingSummary}` : ""} (rev ${view.revision})`;

const leafSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("time"),
    at: Type.Number({ description: "Absolute due time in epoch milliseconds (compute it — the host stores the instant, not the text)" }),
    timezone: Type.Optional(Type.String({ description: "IANA timezone the user meant, kept for display" })),
  }, { description: "Fire at a point in time" }),
  Type.Object({
    kind: Type.Literal("experiment"),
    attemptId: Type.String({ description: "Attempt id returned by the experiment tool's submit action" }),
    states: Type.Optional(Type.Array(Type.String(), { description: "Terminal states that satisfy the wait (default: completed/failed/cancelled/lost)" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline — if the attempt is still running then, fire a 'deadline' occurrence instead of waiting silently forever" })),
  }, { description: "Fire when an experiment attempt reaches a terminal state" }),
  Type.Object({
    kind: Type.Literal("artifact"),
    attemptId: Type.String({ description: "Attempt id whose artifacts to watch" }),
    artifactId: Type.Optional(Type.String({ description: "Bind one artifact identity (or use name)" })),
    name: Type.Optional(Type.String({ description: "Bind by artifact name/path within the attempt" })),
    every: Type.Optional(Type.Boolean({ description: "true: fire per artifact as it becomes collected (default: once when ready/missing/failed)" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire when an attempt's artifact is collected (or fails/is missing)" }),
  Type.Object({
    kind: Type.Literal("file"),
    path: Type.String({ description: "Workspace-relative path, forward slashes" }),
    condition: Type.Union([Type.Literal("exists"), Type.Literal("changed"), Type.Literal("ready")], {
      description: "exists: first durable presence; changed: each durable change; ready: present AND no active writer + stable across a quiet window",
    }),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire on a workspace file condition through the document authority" }),
  Type.Object({
    kind: Type.Literal("log"),
    attemptId: Type.String({ description: "Attempt id whose durable log to match" }),
    stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")])),
    pattern: Type.String({ description: "Literal text (or JS RegExp with regex=true) to match incrementally" }),
    regex: Type.Optional(Type.Boolean()),
    every: Type.Optional(Type.Boolean({ description: "true: fire per new match (default: first match only)" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire when the attempt's log matches a pattern — incremental cursor, never rescans" }),
  Type.Object({
    kind: Type.Literal("metric"),
    machineId: Type.String({ description: "Machine id from the resources overview" }),
    metric: Type.String({ description: "cpuPercent | memoryMb | gpu:<index>.percent | gpu:<index>.memoryMb" }),
    predicate: Type.Union([Type.Literal("above"), Type.Literal("below")]),
    threshold: Type.Number(),
    every: Type.Optional(Type.Boolean({ description: "true: fire on each threshold crossing (default: once)" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire on a usage-metric threshold crossing — steady-true never re-wakes" }),
  Type.Object({
    kind: Type.Literal("external"),
    provider: Type.Literal("github-pr", { description: "Registered adapter id — currently only github-pr" }),
    branch: Type.Optional(Type.String({ description: "Branch to check (default: workspace checkout branch)" })),
    remote: Type.Optional(Type.String({ description: "Remote name override (default: origin/tracking)" })),
    condition: Type.Union([Type.Literal("exists"), Type.Literal("open"), Type.Literal("merged"), Type.Literal("closed")]),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire when a GitHub PR reaches a state — typed adapter, deterministic queries" }),
  Type.Object({
    kind: Type.Literal("shell"),
    executionId: Type.String({ description: "Stable executionId returned by an ordinary bash/powershell command" }),
    condition: Type.Union([Type.Literal("exit"), Type.Literal("output"), Type.Literal("status")]),
    pattern: Type.Optional(Type.String({ description: "output only: literal text, or a JavaScript RegExp with regex=true" })),
    regex: Type.Optional(Type.Boolean()),
    states: Type.Optional(Type.Array(Type.Union([
      Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"),
      Type.Literal("cancelled"), Type.Literal("unavailable"),
    ]), { description: "status only: states that wake the follow-up" })),
    every: Type.Optional(Type.Boolean({ description: "output only: fire for each later committed match" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire from an ordinary background shell's durable lifecycle or streamed output match" }),
  Type.Object({
    kind: Type.Literal("desktop"),
    desktopId: Type.String({ description: "Catalog desktop id (local-console, managed-linux, remote:r*:…) — the machine the watched state lives on" }),
    condition: Type.Union([Type.Literal("status"), Type.Literal("artifact")], {
      description: "status: catalog status becomes one of `states`; artifact: file in the managed desktop home exists or its stored revision differs from `sha256`",
    }),
    states: Type.Optional(Type.Array(Type.String(), { description: "status only: statuses that satisfy the wait (e.g. available, unavailable)" })),
    path: Type.Optional(Type.String({ description: "artifact only: path relative to the managed desktop user's home" })),
    sha256: Type.Optional(Type.String({ description: "artifact only: fire when the stored revision differs from this registered revision" })),
    every: Type.Optional(Type.Boolean({ description: "status: fire on each new matching state; artifact: fire on each new revision" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop" })),
  }, { description: "Fire on a desktop's real state — catalog status or a managed-home file revision (polled; a remote desktop is only as fresh as its last successful observation)" }),
  Type.Object({
    kind: Type.Literal("manual"),
    note: Type.Optional(Type.String({ description: "What is being awaited, for the audit trail" })),
  }, { description: "Fire only via check/fire — e.g. a signal the program cannot observe" }),
]);

const sourceSchema = Type.Union([
  leafSourceSchema,
  Type.Object({
    kind: Type.Literal("any"),
    sources: Type.Array(leafSourceSchema, { minItems: 1, description: "Ordinary sources; the first durable signal wakes the follow-up" }),
    every: Type.Optional(Type.Boolean({ description: "Re-arm repeatable edge sources after each occurrence" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop for the combined wait" })),
  }),
  Type.Object({
    kind: Type.Literal("all"),
    sources: Type.Array(leafSourceSchema, { minItems: 1, description: "Ordinary sources; each must durably signal before wakeup" }),
    every: Type.Optional(Type.Boolean({ description: "Start another cycle; one-shot leaves cannot satisfy a later cycle without a new event" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline backstop for the combined wait" })),
  }),
]);

export function createFollowUpTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "follow_up",
    label: "Follow-up",
    description:
      "Register a durable follow-up on this conversation: what to wait for and what to do when it happens. Sources: time, experiment terminal, artifact collection, workspace file, log pattern, machine metric crossing, ordinary background shell, desktop status/file revision, external GitHub PR state, manual, or an any/all combination of these. The host watches the source — you do not poll. When it fires, this thread resumes with the trigger facts. Actions: register, list, get, update, cancel, check, fire.",
    promptSnippet: "follow_up: durable wait + continuation (register/list/get/update/cancel/check/fire)",
    promptGuidelines: [
      "Register AFTER the work exists: an experiment/artifact/log source needs the real attemptId from experiment submit, a file source needs a workspace-relative path, a metric source needs a machineId from the resources overview, a time source needs a concrete epoch-ms instant you computed.",
      "Sources bind real events: artifact fires when collection makes the artifact available (or reports missing/failed); file 'ready' requires no active writer plus a stable stat — a bare file appearing is never 'ready'; metric fires only on threshold crossings, never on a steady-true stream; log matches incrementally by byte cursor.",
      "A shell source uses the executionId returned by bash/powershell. It does not turn the command into an experiment: completion is durable, output matching stores only compact match/cursor facts, and a still-running local process becomes unavailable after a Host restart when it cannot be reattached.",
      "A desktop source watches the computer catalog: `status` fires when the desktop reports one of `states` (available/unavailable/busy — take IDs from the computer list), `artifact` fires when a file exists in the managed desktop user's home or its stored revision differs from `sha256`. Desktop observation is polled — the facts carry each check's observedAt; a remote desktop is only as fresh as its last reachable sync.",
      "Use {kind:'any', sources:[...]} for the first matching source or {kind:'all', sources:[...]} to latch each source. Combinations are one-shot unless every=true; later cycles require new repeatable edges, so a due time or already-completed attempt does not manufacture repeated wakeups.",
      "Registration is non-blocking — keep working unless the user asked you to wait. With pause=true the thread is marked waiting, the goal pauses, and the trigger resumes the run; without it the trigger arrives as a message while you work.",
      "check is a program-side evaluation of the source (is the attempt done yet?) — it fires the follow-up if satisfied but never calls the model. fire invokes you now.",
      "Only a successful register result means the follow-up exists — never promise a trigger for a failed or unconfirmed registration.",
      "cancel stops the waiting, not the underlying work — cancelling a follow-up never kills the experiment it watches.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("register"), Type.Literal("list"), Type.Literal("get"),
        Type.Literal("update"), Type.Literal("cancel"), Type.Literal("check"),
        Type.Literal("fire"),
      ]),
      id: Type.Optional(Type.String({ description: "Follow-up id (get/update/cancel/check/fire)" })),
      instruction: Type.Optional(Type.String({
        description: "register/update: what to do when the source fires — natural language, e.g. \"if the run failed, diagnose and retry the data step\"",
      })),
      source: Type.Optional(sourceSchema),
      pause: Type.Optional(Type.Boolean({
        description: "register: explicitly end the turn and wait — pauses the goal and marks the thread waiting until the source fires (default false)",
      })),
      expectedRevision: Type.Optional(Type.String({ description: "CAS guard for update/cancel/fire — the revision returned by get" })),
      includeInactive: Type.Optional(Type.Boolean({ description: "list: include delivered/cancelled follow-ups (default false)" })),
      reason: Type.Optional(Type.String({ description: "fire: reason recorded on the forced occurrence" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const request = <M extends HarnessMethod>(method: M, body: HarnessServiceMap[M]["params"]) =>
        bridge.request(method, body, signal ? { signal } : undefined);
      try {
        switch (params.action) {
          case "register": {
            if (!params.instruction?.trim()) {
              return invalidParams("follow_up", "register requires instruction — what to do when the source fires");
            }
            if (!params.source) {
              return invalidParams("follow_up", "register requires source — what to wait for");
            }
            const result = await request("followup.register", {
              source: params.source,
              instruction: params.instruction,
              ...(params.pause !== undefined ? { pause: params.pause } : {}),
            }) as FollowUpRegisterResult;
            const lines = [
              `Follow-up registered: ${describeView(result.followUp)}`,
              `Waiting for ${describeSource(result.followUp.source as unknown as Record<string, unknown>)}.`,
              result.followUp.pausedGoal
                ? "Goal paused — this thread resumes when the source fires."
                : "You can keep working; the trigger arrives in this thread.",
            ];
            if (result.firedImmediately) {
              lines.push("The source was already satisfied — the follow-up fired during registration.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "list": {
            const result = await request("followup.list", {
              ...(params.includeInactive !== undefined ? { includeInactive: params.includeInactive } : {}),
            }) as FollowUpListResult;
            if (result.followUps.length === 0) {
              return {
                content: [{ type: "text", text: "No follow-ups registered on this thread." }],
                details: { total: 0 },
              };
            }
            return {
              content: [{ type: "text", text: result.followUps.map(describeView).join("\n") }],
              details: { total: result.followUps.length, followUps: result.followUps as unknown as Record<string, unknown>[] },
            };
          }
          case "get": {
            if (!params.id) return invalidParams("follow_up", "get requires id");
            const result = await request("followup.get", { id: params.id }) as FollowUpGetResult;
            const lines = [describeView(result.followUp), `instruction: ${result.followUp.instruction}`];
            for (const occurrence of result.occurrences) {
              lines.push(`  occurrence ${occurrence.id} [${occurrence.delivery}] ${occurrence.reason} at ${new Date(occurrence.at).toISOString()}`);
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "update": {
            if (!params.id) return invalidParams("follow_up", "update requires id");
            if (params.instruction === undefined && params.source === undefined) {
              return invalidParams("follow_up", "update requires instruction and/or source");
            }
            const result = await request("followup.update", {
              id: params.id,
              ...(params.instruction !== undefined ? { instruction: params.instruction } : {}),
              ...(params.source !== undefined ? { source: params.source } : {}),
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpUpdateResult;
            return {
              content: [{ type: "text", text: `Updated: ${describeView(result.followUp)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "cancel": {
            if (!params.id) return invalidParams("follow_up", "cancel requires id");
            const result = await request("followup.cancel", {
              id: params.id,
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpGetResult;
            return {
              content: [{ type: "text", text: `Cancelled: ${describeView(result.followUp)} — the watched work itself is unaffected.` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "check": {
            if (!params.id) return invalidParams("follow_up", "check requires id");
            const result = await request("followup.check", { id: params.id }) as FollowUpCheckResult;
            const observed = result.observed
              ? Object.entries(result.observed).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")
              : "";
            return {
              content: [{
                type: "text",
                text: `${describeView(result.followUp)}${result.fired ? " — condition held; follow-up fired" : ""}${observed ? `\nobserved: ${observed}` : ""}`,
              }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "fire": {
            if (!params.id) return invalidParams("follow_up", "fire requires id");
            const result = await request("followup.fire", {
              id: params.id,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpGetResult;
            return {
              content: [{ type: "text", text: `Fired: ${describeView(result.followUp)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          default:
            return invalidParams("follow_up", `unknown action "${String(params.action)}"`);
        }
      } catch (error) {
        return errorResult("follow_up", error);
      }
    },
  });
}
