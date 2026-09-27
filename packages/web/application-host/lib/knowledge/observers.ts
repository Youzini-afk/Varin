/**
 * Host observers — subscribe to document/terminal/lsp/git events and write
 * them as `event` nodes to the knowledge store.
 *
 * Design: design/harness-knowledge.md §7.3
 * Plan: plan/agent-harness-plan.md §2.3
 *
 * Source determination:
 * - Document write with active `pi-worker` writer → 'agent'
 * - Document write without active writer → 'user' (editor save) or 'external'
 * - Terminal exit from harness shell supervisor → 'agent'
 * - Terminal exit from user terminal tab → 'user'
 */

import { terminalCommandDedupeKey, type KnowledgeStore, type EventInput, type EventSource } from "./store.js";

// ── Observer interfaces ────────────────────────────────────────────

export interface DocumentWriteEvent {
  workspaceId: string;
  path: string;
  kind: "modified" | "created" | "deleted";
  /** Whether a pi-worker (agent) writer was active at write time */
  agentWriterActive: boolean;
  turnIndex?: number;
}

export interface TerminalExitEvent {
  workspaceId: string;
  sessionId: string;
  command: string;
  commandId?: string;
  cwd?: string;
  endedAt?: number;
  exitCode: number;
  integration?: "osc-633";
  /** Whether this came from a harness shell (agent) or user terminal (user) */
  source: "harness" | "user";
  startedAt?: number;
  turnIndex?: number;
}

export type TerminalCommandEvent = TerminalExitEvent & {
  commandId: string;
};

export interface DiagnosticEvent {
  workspaceId: string;
  sessionId: string;
  path: string;
  count: number;
  worst: "error" | "warning";
  turnIndex?: number;
}

export interface GitStatusEvent {
  workspaceId: string;
  branch?: string;
  changed?: number;
  note?: string;
  turnIndex?: number;
}

// ── Source determination ───────────────────────────────────────────

export function determineWriteSource(agentWriterActive: boolean): EventSource {
  return agentWriterActive ? "agent" : "user";
}

export function determineTerminalSource(source: "harness" | "user"): EventSource {
  return source === "harness" ? "agent" : "user";
}

// ── Observer ───────────────────────────────────────────────────────

export interface ObserverDeps {
  store: KnowledgeStore;
  sessionId: string;
}

export function createObservers(deps: ObserverDeps) {
  const { store, sessionId } = deps;

  async function onDocumentWrite(event: DocumentWriteEvent): Promise<void> {
    const source = determineWriteSource(event.agentWriterActive);
    const input: EventInput = {
      kind: "edit",
      at: Date.now(),
      sessionId,
      ...(event.turnIndex === undefined ? {} : { turnIndex: event.turnIndex }),
      text: `${event.kind} ${event.path}`,
      refs: { path: event.path },
      data: { kind: event.kind, path: event.path },
      source,
    };
    await store.putEvent(input);
  }

  async function onTerminalExit(event: TerminalExitEvent): Promise<boolean> {
    const source = determineTerminalSource(event.source);
    const at = event.endedAt ?? Date.now();
    const cwdSuffix = event.cwd ? `  (${event.cwd})` : "";
    const input: EventInput = {
      kind: "command",
      at,
      sessionId,
      ...(event.turnIndex === undefined ? {} : { turnIndex: event.turnIndex }),
      text: `exit ${event.exitCode} · ${event.command}${cwdSuffix}`,
      ...(event.sessionId ? { refs: { handle: event.sessionId } } : {}),
      data: {
        command: event.command,
        exitCode: event.exitCode,
        origin: event.source,
        ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
        ...(event.integration === undefined ? {} : { integration: event.integration }),
        ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
        ...(event.endedAt === undefined ? {} : { endedAt: event.endedAt }),
      },
      ...(event.commandId === undefined ? {} : { dedupeKey: terminalCommandDedupeKey(sessionId, event.commandId) }),
      source,
    };
    const result = await store.putEvent(input);
    return result.inserted;
  }

  async function onDiagnostics(event: DiagnosticEvent): Promise<void> {
    const input: EventInput = {
      kind: "diagnostic",
      at: Date.now(),
      sessionId,
      ...(event.turnIndex === undefined ? {} : { turnIndex: event.turnIndex }),
      text: `${event.path}: ${event.count} ${event.worst}${event.count > 1 ? "s" : ""}`,
      refs: { path: event.path },
      data: { count: event.count, path: event.path, worst: event.worst },
      source: "external",
    };
    await store.putEvent(input);
  }

  async function onGitStatus(event: GitStatusEvent): Promise<void> {
    const parts: string[] = [];
    if (event.branch) parts.push(`branch ${event.branch}`);
    if (event.changed !== undefined) parts.push(`${event.changed} files changed`);
    if (event.note) parts.push(event.note);
    const input: EventInput = {
      kind: "source",
      at: Date.now(),
      sessionId,
      ...(event.turnIndex === undefined ? {} : { turnIndex: event.turnIndex }),
      text: `git: ${parts.join(", ")}`,
      data: {
        type: "git",
        ...(event.branch === undefined ? {} : { branch: event.branch }),
        ...(event.changed === undefined ? {} : { changed: event.changed }),
        ...(event.note === undefined ? {} : { note: event.note }),
      },
      source: "external",
    };
    await store.putEvent(input);
  }

  return {
    onDocumentWrite,
    onTerminalExit,
    onDiagnostics,
    onGitStatus,
  };
}

export type Observers = ReturnType<typeof createObservers>;
