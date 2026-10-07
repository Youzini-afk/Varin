import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  SettingsActionResult,
  SettingsReadResult,
  SettingsSearchResult,
  SettingsUpdateResult,
} from "@varin/protocol";

/**
 * Conversational settings tools (D-306 / Stage S).
 *
 * Three stable entry points over the shared settings catalog — search by
 * text/category, read one stable id for the owner-backed value + effective
 * state + revision, and update/reset with CAS. The catalog is the same
 * descriptor list the settings UI searches, and every write goes through the
 * owning authority (app settings store or Pi settings.json) — there is no
 * agent-only settings copy.
 */

const invalidParams = (toolName: string, message: string): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => ({
  content: [{ type: "text" as const, text: `${toolName} failed (invalid-params): ${message}` }],
  isError: true as const,
  details: { code: "invalid-params" },
});

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

export function createSettingsSearchTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_search",
    label: "Settings Search",
    description: "Find settings by question, keyword, category, or stable id. Returns catalog rows with the paths they control, who owns them (app host settings, Pi settings, device-local, or a domain action), and whether the agent can write them.",
    promptSnippet: "settings_search: locate a setting by keyword, category, or id",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Free-text AND match over ids, paths, and keywords" })),
      category: Type.Optional(Type.String({ description: "Limit to one category" })),
      owner: Type.Optional(Type.Union([
        Type.Literal("app"), Type.Literal("pi-settings"),
        Type.Literal("client"), Type.Literal("action"),
      ])),
      id: Type.Optional(Type.String({ description: "Exact stable id lookup" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request<"settings.search">("settings.search", params, signal ? { signal } : undefined) as SettingsSearchResult;
        if (result.items.length === 0) {
          const categories = result.categories.map(item => `${item.category} (${item.count})`).join(', ');
          const related = result.related?.map(item => `- ${item.id} → ${item.paths.join(', ')}`).join('\n');
          return {
            content: [{ type: "text", text: `No settings matched the full query${params.query ? ` "${params.query}"` : ""}.${related ? `\nRelated keyword matches:\n${related}` : ''}\nBrowse with category: ${categories || '(none available)'}.` }],
            details: { total: 0, categories: result.categories, ...(result.related ? { related: result.related } : {}) },
          };
        }
        const lines = result.items.map((item) => {
          const paths = item.paths.length > 0 ? ` → ${item.paths.join(", ")}` : "";
          const writable = item.writable ? "" : " (read-only)";
          const summary = item.summary;
          const facts: string[] = [];
          if (summary?.fieldKind) facts.push(`kind: ${summary.fieldKind}`);
          if (summary?.options) facts.push(`options: ${summary.options.map((option) => option.value).join("/") || "(none)"}`);
          if (summary?.value !== undefined) facts.push(`now: ${JSON.stringify(summary.value)} (${summary.source ?? "?"})`);
          else if (summary?.source) facts.push(`now: (unset) (${summary.source})`);
          if (summary?.isSet !== undefined) facts.push(summary.isSet ? "credential: set" : "credential: unset");
          if (summary?.verbs?.length) facts.push(`verbs: ${summary.verbs.join("/")}`);
          if (summary?.surfaces !== undefined) facts.push(`surfaces: ${summary.surfaces}`);
          const factText = facts.length ? ` — ${facts.join("; ")}` : "";
          return `- ${item.id} [${item.owner}${writable}]${item.apply ? ` apply:${item.apply}` : ""}${paths}${factText}${item.note ? ` — ${item.note}` : ""}`;
        });
        return {
          content: [{ type: "text", text: `${result.total} match(es):\n${lines.join("\n")}` }],
          details: { total: result.total, categories: result.categories, items: result.items },
        };
      } catch (error) {
        return errorResult("settings_search", error);
      }
    },
  });
}

export function createSettingsReadTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_read",
    label: "Settings Read",
    description: "Read one catalog setting by stable id: saved value, effective value and its source, document revision for safe updates, dynamic options, and related settings. detail=true adds options/related/help for complex entries.",
    promptSnippet: "settings_read: current value, effective source, and revision for one setting id",
    promptGuidelines: [
      "state distinguishes ok, denied, malformed, unavailable, action, and no-value. Credential fields expose set/unset status rather than secret values.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable catalog id from settings_search" }),
      scope: Type.Optional(Type.Union([
        Type.Literal("global"), Type.Literal("project"), Type.Literal("effective"),
      ], { description: "Pi settings only: which layer to read (default effective)" })),
      detail: Type.Optional(Type.Boolean({ description: "Resolve dynamic options, related ids, and help pointers" })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      if (!params.id?.trim()) return invalidParams("settings_read", "id is required");
      try {
        const result = await bridge.request<"settings.read">("settings.read", {
          id: params.id,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.detail !== undefined ? { detail: params.detail } : {}),
        }, signal ? { signal } : undefined) as SettingsReadResult;
        const parts: string[] = [`${result.entry.id} — state: ${result.state}`];
        if (result.reason) parts.push(`reason: ${result.reason}`);
        if (result.fields) {
          for (const field of result.fields) {
            const shown = field.kind === "secret"
              ? (field.isSet ? "(set)" : "(unset)")
              : (field.isSet ? JSON.stringify(field.saved) : "(unset)");
            parts.push(`  ${field.path}: ${shown}`);
          }
        }
        if (result.effective) {
          parts.push(`effective: ${JSON.stringify(result.effective.value)} (source: ${result.effective.source})`);
        }
        if (result.revision) parts.push(`revision: ${result.revision}`);
        if (result.revisions) {
          parts.push(`revisions: global=${result.revisions.global ?? "-"} project=${result.revisions.project ?? "-"}`);
        }
        if (result.options?.length) {
          parts.push(`options: ${result.options.map((option) => option.label ? `${option.value} (${option.label})` : option.value).join(", ")}`);
        }
        if (result.related?.length) parts.push(`related: ${result.related.join(", ")}`);
        if (result.action) {
          parts.push(`action domain: ${result.action.domain}${result.action.verbs?.length ? ` verbs: ${result.action.verbs.join(", ")}` : ""}${result.action.note ? ` — ${result.action.note}` : ""}`);
          if (result.action.status) parts.push(`action status: ${result.action.status}`);
          if (result.action.data !== undefined) parts.push(`action state: ${JSON.stringify(result.action.data)}`);
        }
        if (result.help) parts.push(`help: ${result.help}`);
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { result: result as unknown as Record<string, unknown> },
        };
      } catch (error) {
        return errorResult("settings_read", error);
      }
    },
  });
}

export function createSettingsUpdateTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_update",
    label: "Settings Update",
    description: "Change or reset settings by stable id — single entry via set/reset, or several entries at once via items[]. All declared fields are validated against the owner contract — invalid fields fail loudly instead of being dropped. Pass expectedRevision from settings_read to guard against concurrent user edits.",
    promptSnippet: "settings_update: set or reset fields on catalog ids (CAS via expectedRevision; items[] for compound changes)",
    promptGuidelines: [
      "Pi scope is global by default; project writes require trust, and user-owned fields accept only global scope.",
      "appliedAt identifies immediate, next-run, restart, or manual application. partial reports per-field failures. Same-owner items commit atomically; cross-owner items have separate outcomes.",
      "Client-owned entries resolve from the caller's live session: zero connected surfaces is unavailable and multiple surfaces is ambiguous. Action entries use settings_action.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable catalog id (first item's id for compound updates)" }),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")],
        { description: "Pi settings only: which file to write (default global)" })),
      set: Type.Optional(Type.Record(Type.String(), Type.Unknown(),
        { description: "field path → value; every path must belong to the entry" })),
      reset: Type.Optional(Type.Array(Type.String(),
        { description: "field paths to clear back to default" })),
      expectedRevision: Type.Optional(Type.String(
        { description: "revision from settings_read; conflicting writes are rejected" })),
      items: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: "Stable catalog id" }),
        scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
        set: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        reset: Type.Optional(Type.Array(Type.String())),
        expectedRevision: Type.Optional(Type.String({ description: "revision for this item's owning document/scope" })),
      }), { description: "Compound update: several catalog entries in one request; per-item results are returned" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      if (!params.id?.trim() && !params.items?.length) {
        return invalidParams("settings_update", "id is required for a single update; compound updates pass items[]");
      }
      if (!params.set && !params.reset?.length && !params.items?.length) {
        return invalidParams("settings_update", "provide set and/or reset, or items[]");
      }
      try {
        const result = await bridge.request<"settings.update">("settings.update", {
          id: params.id,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.set ? { set: params.set } : {}),
          ...(params.reset ? { reset: params.reset } : {}),
          ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {}),
          ...(params.items ? {
            items: params.items.map((item) => ({
              id: item.id,
              ...(item.scope ? { scope: item.scope } : {}),
              ...(item.set ? { set: item.set } : {}),
              ...(item.reset ? { reset: item.reset } : {}),
              ...(item.expectedRevision ? { expectedRevision: item.expectedRevision } : {}),
            })),
          } : {}),
        }, signal ? { signal } : undefined) as SettingsUpdateResult;
        const parts = [
          `${result.entry.id} — ${result.status} (scope: ${result.scope}, applies: ${result.appliedAt})`,
          ...result.fields.map((field) =>
            `  ${field.path}: ${field.status}${field.error ? ` — ${field.error}` : ""}`),
        ];
        if (result.items?.length) {
          for (const item of result.items) {
            parts.push(`  ${item.id}: ${item.status}${item.error ? ` — ${item.error}` : ""}${item.revision ? ` (rev ${item.revision})` : ""}`);
            for (const field of item.fields ?? []) {
              parts.push(`    ${field.path}: ${field.status}${field.error ? ` — ${field.error}` : ""}`);
            }
          }
        }
        if (result.surface) {
          parts.push(`surface: ${result.surface.kind}:${result.surface.id}`);
          for (const surfaceResult of result.surface.results) {
            parts.push(`  ${surfaceResult.path}: ${surfaceResult.status}${surfaceResult.error ? ` — ${surfaceResult.error}` : ""}`);
          }
        }
        if (result.revision) parts.push(`revision: ${result.revision}`);
        if (result.effective) {
          parts.push(`effective now: ${JSON.stringify(result.effective)}`);
        }
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: result.status === "failed",
          details: { result: result as unknown as Record<string, unknown> },
        };
      } catch (error) {
        return errorResult("settings_update", error);
      }
    },
  });
}

export function createSettingsActionTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_action",
    label: "Settings Action",
    description: "Invoke a real domain operation on an action-owned catalog entry — provider authentication and connection state, MCP server changes, Pi package/resource management, extensions, tunnel, remote instances, language support, runtime updates, git identities, knowledge, and project metadata. Awaited owner facts return applied/failed; an asynchronous owner returns a durable operation id only when its real status path is available.",
    promptSnippet: "settings_action: run a domain operation on an action-owned catalog entry",
    promptGuidelines: [
      "Action verbs and current owner state come from settings_read. Verb arguments are passed in args. Pending operations include an operation id for verb=status; cancellation is available only when the owner exposes it.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable catalog id of an owner:action entry" }),
      verb: Type.String({ description: "One of the entry's advertised verbs" }),
      operationId: Type.Optional(Type.String({ description: "Owner operation id returned by an earlier settings_action" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(),
        { description: "Verb arguments — e.g. providerId, source, name, content, expectedRevision" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      if (!params.id?.trim()) return invalidParams("settings_action", "id is required");
      if (!params.verb?.trim()) return invalidParams("settings_action", "verb is required");
      try {
        const result = await bridge.request<"settings.action">("settings.action", {
          id: params.id,
          verb: params.verb,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.args ? { args: params.args } : {}),
        }, signal ? { signal } : undefined) as SettingsActionResult;
        const parts = [`${result.entry.id} ${result.verb} — ${result.status}`];
        if (result.detail) parts.push(result.detail);
        if (result.operation) {
          parts.push(`operation: ${result.operation.id} (${result.operation.state})${result.operation.cancelVerb ? ` — cancel via "${result.operation.cancelVerb}"` : ""}`);
        }
        if (result.data !== undefined) {
          parts.push(JSON.stringify(result.data));
        }
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: result.status === "failed" || result.status === "denied",
          details: { result: result as unknown as Record<string, unknown> },
        };
      } catch (error) {
        return errorResult("settings_action", error);
      }
    },
  });
}
