import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";
import type {
  HarnessMethod,
  HarnessServiceMap,
  ScheduleGetResult,
  ScheduleListResult,
  ScheduleLoopReadResult,
  ScheduleLoopRemoveResult,
  ScheduleLoopUpdateResult,
  ScheduleRunResult,
  ScheduleSetEnabledResult,
  ScheduleStatusResult,
  ScheduleUpsertResult,
  ScheduleRemoveResult,
  ScheduledTaskView,
} from "@varin/protocol";

/**
 * Scheduled-task tool (D-307 / Stage W-C): manage the calling workspace
 * project's calendar tasks through the same authority the GUI, CLI, and
 * Markdown `.agents/loops` files use.
 *
 * A calendar task creates NEW work — each fire starts a fresh session in the
 * project with the configured model/prompt. That is the opposite target type
 * of `follow_up`, which resumes THIS existing thread when a condition holds.
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

const describeSchedule = (schedule: ScheduledTaskView["schedule"]): string => {
  const zone = schedule.timezone ? ` ${schedule.timezone}` : "";
  switch (schedule.kind) {
    case "daily":
      return `daily ${schedule.times?.join(", ") ?? schedule.time ?? ""}${zone}`;
    case "weekly":
      return `weekly weekdays ${schedule.weekdays?.join("/") ?? "?"} at ${schedule.times?.join(", ") ?? schedule.time ?? ""}${zone}`;
    case "once":
      return `once ${schedule.date ?? "?"} ${schedule.time ?? ""}${zone}`;
    case "cron":
      return `cron "${schedule.cron ?? ""}"${zone}`;
    default:
      return String(schedule.kind ?? "unknown");
  }
};

const describeTask = (task: ScheduledTaskView): string => {
  const parts = [
    `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name} — ${describeSchedule(task.schedule)}`,
    task.runtime === 'agent' ? `  Agent calendar: ${task.calendar?.definition.calculation_failure ?? (task.calendar?.definition.calculation_pending ? 'calculating' : 'ready')}` : `  status: ${task.state.lastStatus}`,
  ];
  if (task.state.nextRunAt) parts.push(`  next run: ${new Date(task.state.nextRunAt).toISOString()}`);
  if (task.state.lastRunAt) {
    parts.push(`  last run: ${new Date(task.state.lastRunAt).toISOString()}${task.state.lastSessionId ? ` (session ${task.state.lastSessionId})` : ""}`);
  }
  if (task.state.lastError) parts.push(`  last error: ${task.state.lastError}`);
  if (task.loopFile) {
    parts.push(`  loop file: ${task.loopFile} (${task.loopScope ?? "project"} scope${task.loopShadowed ? ", shadowed" : ""}${task.loopRevision ? `, rev ${task.loopRevision}` : ""})`);
  }
  if (task.loopError) parts.push(`  loop error: ${task.loopError}`);
  return parts.join("\n");
};

const scheduleSchema = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("once"), Type.Literal("cron")]),
  timezone: Type.Optional(Type.String({ description: "IANA timezone (default: host local zone)" })),
  time: Type.Optional(Type.String({ description: "\"HH:mm\" — daily/weekly/once" })),
  times: Type.Optional(Type.Array(Type.String(), { description: "Several \"HH:mm\" fire times — daily/weekly" })),
  weekdays: Type.Optional(Type.Array(Type.Number(), { description: "weekly: zero-based weekdays, 0 = Sunday" })),
  date: Type.Optional(Type.String({ description: "once: \"yyyy-MM-dd\"" })),
  cron: Type.Optional(Type.String({ description: "cron expression evaluated in timezone" })),
});

const executionSchema = Type.Object({
  providerID: Type.String({ description: "Provider id for the new session's model" }),
  modelID: Type.String({ description: "Model id" }),
  thinkingLevel: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max" })),
  agent: Type.Optional(Type.String({ description: "Pi agent role/profile name to use for the turn" })),
  prompt: Type.String({ description: "Prompt text for each run — a leading / dispatches a Pi command instead" }),
  runAsGoal: Type.Optional(Type.Boolean({ description: "Start a persisted Pi goal that runs until its terminal state" })),
  goalTokenBudget: Type.Optional(Type.Number({ description: "Token budget for goal runs" })),
});

export function createScheduledTaskTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "scheduled_task",
    label: "Scheduled Task",
    description:
      "Manage this project's calendar tasks — recurring or one-shot work that starts a NEW session each time it fires (daily/weekly/once/cron). The same task list the GUI, CLI, and .agents/loops Markdown files edit. Actions: list, get, upsert, remove, run, set_enabled, read_loop, write_loop, remove_loop, status.",
    promptSnippet: "scheduled_task: project calendar tasks (list/get/upsert/remove/run/set_enabled/read_loop/write_loop/remove_loop/status)",
    promptGuidelines: [
      "Calendar tasks start new sessions. follow_up instead resumes the current conversation on a condition.",
      "Loop-backed tasks are edited through read_loop/write_loop/remove_loop with their content revision; direct upsert/remove is rejected. Loop definitions default to disabled.",
      "run returns after settlement or timeout; timeout leaves the task running. Recurring schedules skip missed slots; an expired once task runs once on recovery.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("get"), Type.Literal("upsert"),
        Type.Literal("remove"), Type.Literal("run"), Type.Literal("set_enabled"),
        Type.Literal("read_loop"), Type.Literal("write_loop"), Type.Literal("remove_loop"),
        Type.Literal("status"),
      ]),
      taskId: Type.Optional(Type.String({ description: "Task id (get/remove/run/set_enabled/read_loop/write_loop/remove_loop)" })),
      task: Type.Optional(Type.Object({
        id: Type.Optional(Type.String({ description: "Existing task id to update; omit to create" })),
        name: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        schedule: Type.Optional(scheduleSchema),
        execution: Type.Optional(executionSchema),
      }, { description: "upsert: JSON-owned task fields — loop metadata is managed by Varin and rejected" })),
      enabled: Type.Optional(Type.Boolean({ description: "set_enabled: target state" })),
      expectedRevision: Type.Optional(Type.String({ description: "CAS guard — loop content revision from read_loop (required for write_loop, optional for remove_loop)" })),
      content: Type.Optional(Type.String({ description: "write_loop: full Markdown document including YAML frontmatter" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const request = <M extends HarnessMethod>(method: M, body: HarnessServiceMap[M]["params"]) =>
        bridge.request(method, body, signal ? { signal } : undefined);
      // run-now waits for the real session settle — a goal run legitimately
      // outlives the default 30s request window. A longer run reports timeout
      // while the task keeps running; get/list show its true terminal state.
      const requestRun = (body: HarnessServiceMap["schedule.run"]["params"]) =>
        bridge.request("schedule.run", body, {
          timeoutMs: HARNESS_MAX_REQUEST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      const needTaskId = () => params.taskId?.trim() || null;
      try {
        switch (params.action) {
          case "list": {
            const result = await request("schedule.list", {}) as ScheduleListResult;
            const project = result.projectPath ?? result.projectId;
            if (result.tasks.length === 0) {
              return {
                content: [{ type: "text", text: `No scheduled tasks in project ${project}.` }],
                details: { projectId: result.projectId, total: 0 },
              };
            }
            return {
              content: [{ type: "text", text: `Project ${project} — ${result.tasks.length} task(s):\n${result.tasks.map(describeTask).join("\n")}` }],
              details: { projectId: result.projectId, total: result.tasks.length, tasks: result.tasks as unknown as Record<string, unknown>[] },
            };
          }
          case "get": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "get requires taskId");
            const result = await request("schedule.get", { taskId }) as ScheduleGetResult;
            const lines = [describeTask(result.task)];
            lines.push(`  model: ${result.task.execution.providerID}/${result.task.execution.modelID}${result.task.execution.thinkingLevel ? ` thinking:${result.task.execution.thinkingLevel}` : ""}${result.task.execution.agent ? ` agent:${result.task.execution.agent}` : ""}${result.task.execution.runAsGoal ? " (goal)" : ""}`);
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "upsert": {
            if (!params.task || typeof params.task !== "object") {
              return invalidParams("scheduled_task", "upsert requires task — schedule + execution (new) or id + changed fields (existing)");
            }
            const result = await request("schedule.upsert", { task: params.task }) as ScheduleUpsertResult;
            return {
              content: [{ type: "text", text: `${result.created ? "Created" : "Updated"}: ${describeTask(result.task)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "remove": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "remove requires taskId");
            const result = await request("schedule.remove", { taskId }) as ScheduleRemoveResult;
            return {
              content: [{ type: "text", text: `Removed ${taskId} — ${result.tasks.length} task(s) remain.` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "run": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "run requires taskId");
            const result = await requestRun({ taskId, key: _toolCallId }) as ScheduleRunResult;
            return {
              content: [{
                type: "text",
                text: result.runtime === 'agent'
                  ? `Occurrence accepted: ${result.occurrence.id} (${result.occurrence.state}). Read the task for its actual Run/Goal outcome.`
                  : `Run finished: ${describeTask(result.task)}\n  session: ${result.sessionId}`,
              }],
              ...(result.task.state.lastStatus === "error" ? { isError: true } : {}),
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "set_enabled": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "set_enabled requires taskId");
            if (typeof params.enabled !== "boolean") {
              return invalidParams("scheduled_task", "set_enabled requires enabled (boolean)");
            }
            const result = await request("schedule.setEnabled", {
              taskId,
              enabled: params.enabled,
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as ScheduleSetEnabledResult;
            return {
              content: [{ type: "text", text: `${result.task.enabled ? "Enabled" : "Disabled"}: ${describeTask(result.task)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "read_loop": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "read_loop requires taskId of a loop-backed task");
            const result = await request("schedule.loop.read", { taskId }) as ScheduleLoopReadResult;
            return {
              content: [{
                type: "text",
                text: `${result.document.path} (${result.document.scope} scope, rev ${result.document.revision}):\n${result.document.content}`,
              }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "write_loop": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "write_loop requires taskId of a loop-backed task");
            if (typeof params.content !== "string" || !params.content) {
              return invalidParams("scheduled_task", "write_loop requires content — the full Markdown document");
            }
            if (!params.expectedRevision) {
              return invalidParams("scheduled_task", "write_loop requires expectedRevision from read_loop");
            }
            const result = await request("schedule.loop.update", {
              taskId,
              content: params.content,
              expectedRevision: params.expectedRevision,
            }) as ScheduleLoopUpdateResult;
            const lines = [`Loop updated (rev ${result.document.revision}).`];
            if (result.task) lines.push(describeTask(result.task));
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "remove_loop": {
            const taskId = needTaskId();
            if (!taskId) return invalidParams("scheduled_task", "remove_loop requires taskId of a loop-backed task");
            const result = await request("schedule.loop.remove", {
              taskId,
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as ScheduleLoopRemoveResult;
            return {
              content: [{ type: "text", text: `Loop file removed — ${result.tasks.length} task(s) remain.` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "status": {
            const result = await request("schedule.status", {}) as ScheduleStatusResult;
            return {
              content: [{
                type: "text",
                text: `Scheduler: ${result.enabledScheduledTasksCount} enabled, ${result.runningScheduledTasksCount} running.`,
              }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          default:
            return invalidParams("scheduled_task", `unknown action "${String(params.action)}"`);
        }
      } catch (error) {
        return errorResult("scheduled_task", error);
      }
    },
  });
}
