import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HostEventData } from "@varin/protocol";
import type { HostServicesBridge } from "./harness/host-services-bridge.js";
import { withToolExecutionResources } from "./harness/tool-execution-resources.js";

type WorkspaceMutationRequest = HostEventData<"workspace.mutation.request">;
type WorkspaceMutationToolName = WorkspaceMutationRequest["toolName"];
type WithoutRequestIdentity<T> = T extends unknown
  ? Omit<T, "requestId" | "sessionId">
  : never;
type WorkspaceMutationRequestInput = WithoutRequestIdentity<WorkspaceMutationRequest>;

interface PendingMutationRequest {
  resolve: (accepted: boolean) => void;
  sessionId: string;
}

export interface WorkspaceMutationJournalBridgeOptions {
  emit: (event: "workspace.mutation.request", data: WorkspaceMutationRequest) => void;
  sessionId: string;
}

export class WorkspaceMutationJournalBridge {
  readonly #emit: WorkspaceMutationJournalBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingMutationRequest>();
  readonly #sessionId: string;
  #disposed = false;

  constructor(options: WorkspaceMutationJournalBridgeOptions) {
    this.#emit = options.emit;
    this.#sessionId = options.sessionId;
  }

  async request(
    input: WorkspaceMutationRequestInput,
  ): Promise<boolean> {
    if (this.#disposed) return false;
    const requestId = randomUUID();
    let resolveResponse: (accepted: boolean) => void = () => {};
    const response = new Promise<boolean>((resolvePending) => {
      resolveResponse = resolvePending;
    });
    this.#pending.set(requestId, {
      resolve: resolveResponse,
      sessionId: this.#sessionId,
    });
    try {
      this.#emit("workspace.mutation.request", {
        ...input,
        requestId,
        sessionId: this.#sessionId,
      });
    } catch {
      this.#pending.delete(requestId);
      return false;
    }
    return response;
  }

  respond(sessionId: string, requestId: string, accepted: boolean): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.#pending.delete(requestId);
    pending.resolve(accepted);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.resolve(false);
    this.#pending.clear();
  }
}

interface JournaledExecutionOptions<TResult> {
  bridge: WorkspaceMutationJournalBridge;
  cwd: string;
  execute: () => Promise<TResult>;
  inputPath: string;
  toolCallId: string;
  toolName: WorkspaceMutationToolName;
}

export function formatSurfaceWriteResult(
  result: Exclude<import("@varin/protocol").DocumentSurfaceWriteResult, { status: "disk" }>,
  fallbackPath: string,
  action: "write" | "edit" | "delete" | "apply_patch",
): string {
  const results = result.results;
  if (result.status === "applied" && results.length === 1 && results[0]?.status === "applied") {
    const path = results[0].path || fallbackPath;
    if (action === "write") return `Successfully wrote ${path}`;
    if (action === "delete") return `Successfully deleted ${path}`;
    if (action === "edit") return `Successfully edited ${path}`;
    return `patch applied successfully (1 file(s) on ${results[0].target})`;
  }
  const lines = results.map((entry) => (
    `${entry.status} ${entry.path} (${entry.target})${entry.message ? `: ${entry.message}` : ""}`
  ));
  if (result.status === "applied") {
    return action === "apply_patch"
      ? `patch applied successfully (${results.length} file(s))\n${lines.join("\n")}`
      : lines.join("\n");
  }
  return `${result.message ?? `surface mutation ${result.status}`}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}`;
}

export async function fetchDiagnostics(
  bridge: HostServicesBridge,
  path: string,
  waitMs = 5_000,
): Promise<{ status: string; summary: string } | null> {
  try {
    const result = await bridge.request("lsp.diagnostics", { path, waitMs });
    if (result.status === "unavailable") {
      const reason = typeof (result as { reason?: string }).reason === "string"
        ? (result as { reason: string }).reason
        : "no language server";
      return { status: "unavailable", summary: `unavailable — ${reason}` };
    }
    if (result.status === "pending") {
      return { status: "pending", summary: `pending — call diagnostics("${path}")` };
    }
    if (result.diagnostics.length === 0) return { status: "clean", summary: "clean" };
    const errors = result.diagnostics.filter((entry: { severity: string }) => entry.severity === "error").length;
    const warnings = result.diagnostics.filter((entry: { severity: string }) => entry.severity === "warning").length;
    const summary = `${result.diagnostics.length} diagnostic(s)${errors > 0 ? `, ${errors} error(s)` : ""}${warnings > 0 ? `, ${warnings} warning(s)` : ""}`;
    return { status: "ready", summary };
  } catch {
    return { status: "unavailable", summary: "unavailable — request failed" };
  }
}

export async function trySurfaceWrite(
  bridge: HostServicesBridge,
  params: {
    path?: string;
    action?: "write" | "edit" | "delete";
    content?: string;
    edits?: ReadonlyArray<{ oldText: string; newText: string }>;
    changes?: Array<{
      path: string;
      action: "write" | "edit" | "delete";
      content?: string;
      edits?: ReadonlyArray<{ oldText: string; newText: string }>;
      expectedRevision?: string;
      expectedHash?: string;
    }>;
  },
  signal?: AbortSignal,
  label?: "write" | "edit" | "delete" | "apply_patch",
): Promise<"disk" | {
  text: string;
  status: Exclude<import("@varin/protocol").DocumentSurfaceWriteResult, { status: "disk" }>["status"];
  results: Exclude<import("@varin/protocol").DocumentSurfaceWriteResult, { status: "disk" }>["results"];
}> {
  const result = await bridge.request(
    "document.surfaceWrite",
    {
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.action === undefined ? {} : { action: params.action }),
      ...(params.content === undefined ? {} : { content: params.content }),
      ...(params.edits === undefined ? {} : { edits: params.edits }),
      ...(params.changes === undefined ? {} : { changes: params.changes }),
    },
    signal === undefined ? {} : { signal },
  );
  if (result.status === "disk") return "disk";
  const action = label ?? params.action ?? params.changes?.[0]?.action ?? "edit";
  const fallback = params.path ?? params.changes?.[0]?.path ?? "";
  return { text: formatSurfaceWriteResult(result, fallback, action), status: result.status, results: result.results };
}

async function withDiskDiagnostics(
  bridge: HostServicesBridge,
  path: string,
  planned: Exclude<Awaited<ReturnType<typeof trySurfaceWrite>>, "disk">,
): Promise<string> {
  if (!planned.results.some((entry) => entry.target === "disk" && entry.status === "applied")) {
    return planned.text;
  }
  const diagnostics = await fetchDiagnostics(bridge, path);
  return diagnostics ? `${planned.text}\n\n[diagnostics: ${diagnostics.summary}]` : planned.text;
}

async function tryVirtualBranchWrite(
  bridge: HostServicesBridge,
  params: {
    path: string;
    action: "write" | "edit" | "delete";
    content?: string;
    edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  },
  signal?: AbortSignal,
): Promise<"disk" | { text: string }> {
  const result = await bridge.request(
    "document.branchWrite",
    {
      path: params.path,
      action: params.action,
      ...(params.content === undefined ? {} : { content: params.content }),
      ...(params.edits === undefined ? {} : { edits: params.edits }),
    },
    signal === undefined ? {} : { signal },
  );
  if (result.status === "disk") return "disk";
  if (result.status === "committed") {
    return {
      text: params.action === "edit"
        ? `Successfully edited ${params.path}`
        : params.action === "delete"
          ? `Successfully deleted ${params.path}`
          : `Successfully wrote ${params.path}`,
    };
  }
  throw new Error(result.message);
}

async function executeWithMutationJournal<TResult extends { content: Array<{ type: string; text?: string }> }>(
  options: JournaledExecutionOptions<TResult>,
): Promise<TResult> {
  const path = resolve(options.cwd, options.inputPath);
  const executeMutation = async (): Promise<TResult> => {
    await options.bridge.request({
      path,
      phase: "before",
      toolCallId: options.toolCallId,
      toolName: options.toolName,
    });
    let succeeded = false;
    let result: TResult | undefined;
    try {
      result = await options.execute();
      succeeded = true;
    } finally {
      await options.bridge.request({
        path,
        phase: "after",
        succeeded,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
      });
    }
    return result!;
  };
  return executeMutation();
}

export function createWorkspaceMutationJournalTools(
  cwd: string,
  bridge: WorkspaceMutationJournalBridge,
  hostServicesBridge?: HostServicesBridge,
  _sessionId?: string,
  options: { surfaceWrite?: boolean } = {},
): ToolDefinition[] {
  const write = createWriteToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const anchorPath = (input: string) => resolve(cwd, input);
  const surface = options.surfaceWrite === true;
  const journaledWrite = defineTool({
    ...write,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (hostServicesBridge) {
        const virtual = await tryVirtualBranchWrite(hostServicesBridge, {
          path: params.path,
          action: "write",
          content: params.content,
        }, signal);
        if (virtual !== "disk") {
          return { content: [{ type: "text" as const, text: virtual.text }], details: undefined };
        }
        if (surface) {
          const planned = await trySurfaceWrite(hostServicesBridge, {
            path: params.path,
            action: "write",
            content: params.content,
          }, signal);
          if (planned !== "disk") {
            return { content: [{ type: "text" as const, text: await withDiskDiagnostics(hostServicesBridge, params.path, planned) }], details: undefined };
          }
        }
        throw new Error("Host document mutation backend is unavailable; refusing a parallel Pi-worker disk write");
      }
      const anchored = { ...params, path: anchorPath(params.path) };
      return executeWithMutationJournal({
        bridge,
        cwd,
        execute: () => write.execute(toolCallId, anchored, signal, onUpdate, ctx),
        inputPath: anchored.path,
        toolCallId,
        toolName: "write",
      });
    },
  });
  const journaledEdit = defineTool({
    ...edit,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (hostServicesBridge) {
        const virtual = await tryVirtualBranchWrite(hostServicesBridge, {
          path: params.path,
          action: "edit",
          edits: params.edits,
        }, signal);
        if (virtual !== "disk") {
          return { content: [{ type: "text" as const, text: virtual.text }], details: undefined };
        }
        if (surface) {
          const planned = await trySurfaceWrite(hostServicesBridge, {
            path: params.path,
            action: "edit",
            edits: params.edits,
          }, signal);
          if (planned !== "disk") {
            return { content: [{ type: "text" as const, text: await withDiskDiagnostics(hostServicesBridge, params.path, planned) }], details: undefined };
          }
        }
        throw new Error("Host document mutation backend is unavailable; refusing a parallel Pi-worker disk write");
      }
      const anchored = { ...params, path: anchorPath(params.path) };
      return executeWithMutationJournal({
        bridge,
        cwd,
        execute: () => edit.execute(toolCallId, anchored, signal, onUpdate, ctx),
        inputPath: anchored.path,
        toolCallId,
        toolName: "edit",
      });
    },
  });
  return [journaledWrite, journaledEdit].map((tool) => withToolExecutionResources(tool, cwd));
}
