import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, type OutputSlice, type DiagnosticsResult, type ShellReadResult } from "@varin/protocol";

// ── get_output ──────────────────────────────────────────────────────
const GetOutputParams = Type.Object({
  handle: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  length: Type.Optional(Type.Integer({ minimum: 1 })),
  waitMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

const formatElapsed = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) return "unknown time";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
};

export function createGetOutputTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "get_output",
    label: "Get Output",
    description: "Retrieve stored output or accepted shell output. Use offset/length for an explicit historical slice; waitMs waits for preparation, new output, or exit without stopping the process.",
    promptSnippet: "get_output: retrieve stored/shell output, optionally wait for new bytes/exit, paginate with offset/length",
    promptGuidelines: [
      "Use get_output to retrieve large outputs that were truncated or backgrounded.",
      "The handle is shown in the original tool result as out_XXX (stored), sh_N (background shell), or exec_… (accepted while the shell is preparing).",
      "An execution id without offset/length returns only output added since your last read. Do not poll it repeatedly; wait for useful work before checking again.",
    ],
    parameters: GetOutputParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        // Try output.read first (for out_ handles), fall back to shell.read for shell/execution identities.
        let result: OutputSlice & Partial<Pick<ShellReadResult, "running" | "exitCode" | "cancelled" | "executionId" | "cwd" | "command" | "observation" | "display" | "organized" | "shellId" | "spawnFailed" | "unavailable" | "phase">>;
        if (params.handle.startsWith("out_")) {
          const slice = await bridge.request("output.read", {
            handle: params.handle,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.length !== undefined ? { length: params.length } : {}),
          });
          result = { ...slice, running: false };
        } else {
          result = await bridge.request("shell.read", {
            id: params.handle,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.length !== undefined ? { length: params.length } : {}),
            ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
          }, params.waitMs === undefined
            ? (signal === undefined ? {} : { signal })
            : {
                ...(signal === undefined ? {} : { signal }),
                timeoutMs: params.waitMs + 30_000 >= HARNESS_MAX_REQUEST_TIMEOUT_MS
                  ? 0 : Math.max(30_000, params.waitMs + 30_000),
              });
        }
        const shellCompletion = result.running === false && result.executionId
          ? { shellCompletion: { executionId: result.executionId } }
          : {};
        if (result.observation) {
          const state = result.unavailable ? `unavailable: ${result.unavailable}`
            : result.spawnFailed ? `spawn failed: ${result.spawnFailed}`
            : result.phase === "preparing" ? "accepted; preparing (payload not sent yet)"
            : result.running
            ? "still running"
            : result.cancelled ? "cancelled"
              : result.exitCode === undefined ? "exited" : `exited ${result.exitCode}`;
          const observation = result.observation;
          if (!observation.first && result.length === 0) {
            const lastOutput = observation.lastOutputAgoMs === undefined
              ? "no output observed yet"
              : `last output ${formatElapsed(observation.lastOutputAgoMs)} ago`;
            const text = `[shell ${params.handle} · no new output since last read (${formatElapsed(observation.sinceMs)} ago); ${state}; ${lastOutput}]`;
            return {
              content: [{ type: "text", text }],
              details: { handle: params.handle, ...result, ...shellCompletion },
            };
          }
          const change = observation.first
            ? `initial read · ${result.length} bytes`
            : `+${result.length} bytes since last read (${formatElapsed(observation.sinceMs)} ago)`;
          const lines = [`[shell ${params.handle} · ${change} · ${state}]`];
          if (result.shellId && result.shellId !== params.handle) {
            lines.push(`[recovered runtime shell: ${result.shellId} — use this id for input or termination]`);
          }
          if (result.organized?.partial) {
            lines.push(result.running
              ? "[current observation — output still growing; not a final summary]"
              : "[current observation — this is an incremental slice; not a final summary]");
          }
          const body = result.display ?? result.text;
          if (body) lines.push(body);
          lines.push(`[${result.nextOffset}/${result.total} bytes${result.eof ? " · eof" : ""}]`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { handle: params.handle, ...result, ...shellCompletion },
          };
        }
        const lines: string[] = [result.display ?? result.text];
        if (result.unavailable) {
          lines.unshift(`[shell ${params.handle} · unavailable: ${result.unavailable}]`);
        }
        if (result.spawnFailed) {
          lines.unshift(`[shell ${params.handle} · spawn failed: ${result.spawnFailed}]`);
        }
        if (result.shellId && result.shellId !== params.handle) {
          lines.push(`\n[recovered runtime shell: ${result.shellId} — use this id for input or termination]`);
        }
        if (result.running) lines.push(result.phase === "preparing" ? "\n[accepted; preparing (payload not sent yet)]" : "\n[still running]");
        if (result.exitCode !== undefined) lines.push(`\n[exit ${result.exitCode}]`);
        const shown = `${result.nextOffset}/${result.total} bytes${result.eof ? " · eof" : ""}`;
        lines.push(`\n[${shown}]`);
        return {
          content: [{ type: "text", text: lines.join("") }],
          details: {
            handle: params.handle,
            offset: result.offset,
            length: result.length,
            nextOffset: result.nextOffset,
            total: result.total,
            eof: result.eof,
            running: result.running ?? false,
            ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            ...(result.executionId === undefined ? {} : { executionId: result.executionId }),
            ...(result.shellId === undefined ? {} : { shellId: result.shellId }),
            ...(result.phase === undefined ? {} : { phase: result.phase }),
            ...(result.command === undefined ? {} : { command: result.command }),
            ...(result.spawnFailed === undefined ? {} : { spawnFailed: result.spawnFailed }),
            ...(result.unavailable === undefined ? {} : { unavailable: result.unavailable }),
            ...shellCompletion,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `get_output failed: ${message}` }],
          details: { handle: params.handle, error: message },
        };
      }
    },
  });
}

// ── write_to_process ────────────────────────────────────────────────
const WriteToProcessParams = Type.Object({
  shellId: Type.String(),
  text: Type.String(),
});

export function createWriteToProcessTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "write_to_process",
    label: "Write to Process",
    description: "Write text to the stdin of a background shell. Use after a bash command goes background and needs input.",
    promptSnippet: "write_to_process: send stdin to a background shell",
    promptGuidelines: [
      "Use write_to_process to send input to a background shell that is waiting for stdin.",
      "The shellId is shown in the bash result as sh_N.",
    ],
    parameters: WriteToProcessParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("shell.write", {
          id: params.shellId,
          text: params.text,
        });
        return {
          content: [{ type: "text", text: result.accepted ? `wrote ${Buffer.byteLength(params.text, "utf8")} bytes to ${params.shellId}` : `shell ${params.shellId} not found or not writable` }],
          details: { shellId: params.shellId, accepted: result.accepted },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `write_to_process failed: ${message}` }],
          details: { shellId: params.shellId, accepted: false, error: message },
        };
      }
    },
  });
}

// ── kill_shell ──────────────────────────────────────────────────────
const KillShellParams = Type.Object({
  shellId: Type.String(),
});

export function createKillShellTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "kill_shell",
    label: "Kill Shell",
    description: "Terminate a background shell by its shell ID.",
    promptSnippet: "kill_shell: terminate a background shell",
    promptGuidelines: [
      "Use kill_shell to stop a background shell that is no longer needed.",
    ],
    parameters: KillShellParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("shell.kill", { id: params.shellId });
        return {
          content: [{ type: "text", text: result.killed ? `killed ${params.shellId}` : `shell ${params.shellId} not found or termination failed` }],
          details: { shellId: params.shellId, killed: result.killed },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `kill_shell failed: ${message}` }],
          details: { shellId: params.shellId, killed: false, error: message },
        };
      }
    },
  });
}

// ── diagnostics ────────────────────────────────────────────────────
const DiagnosticsParams = Type.Object({
  path: Type.String(),
  full: Type.Optional(Type.Boolean()),
});

export function createDiagnosticsTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "diagnostics",
    label: "Diagnostics",
    description: "Get diagnostic changes for a file. Set full=true for the complete current snapshot.",
    promptSnippet: "diagnostics: get LSP diagnostics for a file (errors, warnings, hints)",
    promptGuidelines: [
      "Use diagnostics after editing a file to check for type errors or lint issues.",
      "An empty result means the file is clean, not that the server is unavailable.",
      "Repeated checks return only added and resolved diagnostics; use full=true only when you need the complete snapshot.",
    ],
    parameters: DiagnosticsParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("lsp.diagnosticsSnapshot", {
          path: params.path,
          ...(params.full === undefined ? {} : { full: params.full }),
        });
        const formatted = formatDiagnosticsResult(result, params.path);
        return { ...formatted, details: { ...(formatted.details as Record<string, unknown>),
          ...(result.observationRef ? { observationRef: result.observationRef } : {}) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `diagnostics failed: ${message}` }],
          details: { path: params.path, status: "unavailable", diagnostics: [] },
        };
      }
    },
  });
}

function formatDiagnosticsResult(result: DiagnosticsResult, path: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  if (result.status === "unavailable") {
    return {
      content: [{ type: "text", text: `diagnostics unavailable for ${path}` }],
      details: { path, status: "unavailable", diagnostics: [] },
    };
  }
  if (result.observation && !result.observation.first) {
    const resolved = result.resolvedDiagnostics ?? [];
    const header = `[${path} · +${result.observation.added} −${result.observation.resolved} since last check (${formatElapsed(result.observation.sinceMs)} ago)]`;
    if (result.diagnostics.length === 0 && resolved.length === 0) {
      return {
        content: [{ type: "text", text: `${header}\nno diagnostic changes; wait until the file or language-server state changes before checking again` }],
        details: { path, status: result.status, diagnostics: [], resolvedDiagnostics: [], observation: result.observation },
      };
    }
    const lines = [header];
    for (const diagnostic of result.diagnostics) {
      lines.push(`  + ${diagnostic.severity} [${diagnostic.source}${diagnostic.code ? `:${diagnostic.code}` : ""}] line ${diagnostic.line}: ${diagnostic.message}`);
    }
    for (const diagnostic of resolved) {
      lines.push(`  − resolved ${diagnostic.severity} [${diagnostic.source}${diagnostic.code ? `:${diagnostic.code}` : ""}] line ${diagnostic.line}: ${diagnostic.message}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { path, status: result.status, diagnostics: result.diagnostics, resolvedDiagnostics: resolved, observation: result.observation },
    };
  }
  if (result.diagnostics.length === 0) {
    return {
      content: [{ type: "text", text: `${path}: clean (0 diagnostics)` }],
      details: { path, status: result.status, diagnostics: [], ...(result.observation ? { observation: result.observation } : {}) },
    };
  }
  const lines: string[] = [`${path}: ${result.diagnostics.length} diagnostic(s)`];
  for (const d of result.diagnostics) {
    lines.push(`  ${d.severity} [${d.source}${d.code ? `:${d.code}` : ""}] line ${d.line}: ${d.message}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      path,
      status: result.status,
      diagnostics: result.diagnostics,
      ...(result.resolvedDiagnostics ? { resolvedDiagnostics: result.resolvedDiagnostics } : {}),
      ...(result.observation ? { observation: result.observation } : {}),
    },
  };
}
