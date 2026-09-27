import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, type ShellExecResult } from "@varin/protocol";

const BashParams = Type.Object({
  command: Type.String(),
  waitMs: Type.Optional(Type.Integer({ minimum: 0 })),
  description: Type.Optional(Type.String()),
  target: Type.Optional(Type.String({ description: "Stable managed execution target from resources; omit for this Host" })),
  cwd: Type.Optional(Type.String({ description: "Absolute working directory on the selected target; remote targets never reuse the local workspace path" })),
});

function formatShellResult(result: ShellExecResult): string {
  const location = result.kind !== "spawn-failed" && result.kind !== "preparing" && result.target
    ? `[target ${result.target} · cwd ${result.cwd}]\n` : "";
  switch (result.kind) {
    case "completed": {
      const lines: string[] = [];
      if (result.organized?.partial) {
        lines.push("[current observation — output may still be incomplete; not a final summary]");
      }
      const body = result.display ?? result.stdout;
      if (body) lines.push(body);
      if (result.stderr) lines.push(`[stderr]\n${result.stderr}`);
      lines.push(`\n[exit ${result.exitCode}]`);
      if (result.handle) {
        lines.push(`[full output: get_output("${result.handle}")]`);
      }
      return `${location}${lines.join("\n")}`;
    }
    case "background": {
      const body = result.display ?? result.outputSoFar;
      const observation = result.organized?.partial
        ? `[Command is still running. waited ${result.waitedMs}ms — current observation, not a final summary]`
        : `[Command is still running. waited ${result.waitedMs}ms]`;
      return `${location}${observation}\n${body}\n\n[Continue: get_output("${result.id}") or write_to_process("${result.id}", "...") or kill_shell("${result.id}")]`;
    }
    case "preparing":
      return `[Command accepted; shell preparation is still in progress. waited ${result.waitedMs}ms — no runtime shell handle exists yet]\n[Continue: get_output("${result.id}")]`;
    case "spawn-failed": {
      return `[spawn failed: ${result.reason}]\n${result.hint ?? ""}`;
    }
    default:
      return `[unknown result kind]`;
  }
}

export function createBashTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  _cwd: string,
  defaultWaitMs = 10_000,
): ToolDefinition {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "Execute an independent bash command and return stdout, stderr, and exit code. Each call starts in its explicit cwd or the request's frozen default cwd; cd and environment changes do not carry into another call. Long-running commands are backgrounded after waitMs. Under PTY-based shells (git-bash, wsl), stdout and stderr are merged into a single stream.",
    promptSnippet: "bash: execute shell commands (bash family)",
    promptGuidelines: [
      "Use bash for independent shell commands. Each call starts in its explicit cwd or frozen default cwd; cd and environment changes do not carry into another call.",
      "For a long-running interactive process, use its returned shell id with get_output, write_to_process, and kill_shell to observe, interact, or stop that process.",
      "A non-zero exit code is a result, not an error. Only use bash when no specialized tool fits.",
      "Prefer grep, edit, read, write, and find tools over bash equivalents.",
    ],
    parameters: BashParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const waitMs = params.waitMs ?? defaultWaitMs;
        // The observation request must outlive the requested foreground wait.
        // This governs the RPC only; it never becomes a process execution limit.
        const requestedTimeoutMs = Math.max(30_000, waitMs + 30_000);
        // A requested foreground wait may exceed the generic RPC ceiling.
        // Shell execution still detaches at waitMs, and actor cancellation
        // remains available; do not turn that wait into a transport failure.
        const requestTimeoutMs = requestedTimeoutMs >= HARNESS_MAX_REQUEST_TIMEOUT_MS
          ? 0 : requestedTimeoutMs;
        const result = await bridge.request("shell.exec", {
          command: params.command,
          toolCallId,
          ...(params.target !== undefined ? { target: params.target } : {}),
          ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
          // Only explicit cwd is forwarded here; the Host resolves the
          // request's frozen default cwd for this command when cwd is omitted.
          waitMs,
        }, {
          timeoutMs: requestTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
        const text = formatShellResult(result);
        const shellCompletion = result.kind === "completed" && result.executionId
          ? { shellCompletion: { executionId: result.executionId } }
          : {};
        return {
          content: [{ type: "text", text }],
          details: { ...result, ...shellCompletion, ...(params.target ? { target: params.target } : {}) },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `bash failed: ${message}\nThe Host may already have accepted this command. Check get_output("${toolCallId}") before retrying it.` }],
          details: { kind: "spawn-failed", reason: "bridge-error", interpreter: "", hint: message } as ShellExecResult,
        };
      }
    },
  });
}
