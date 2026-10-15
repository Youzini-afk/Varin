import type { ThreadObservationIdentity } from './context-runtime.js';
import type { TerminalCommandRecord } from "../terminal/session-api.js";
import type { TerminalCommandEvent } from "./observers.js";

export type TerminalCommandProjectionResult = Readonly<Record<string, boolean>>;

export interface TerminalCommandProjectorDeps {
  drain(): Promise<void>;
  inspectCwd?(terminalId: string): string | undefined;
  listBoundOwners(workspaceId: string): Promise<ThreadObservationIdentity[]>;
  /** Persist the observation for one target native Thread. */
  observe(event: TerminalCommandEvent, target?: ThreadObservationIdentity): boolean | Promise<boolean>;
  onError?(error: unknown): void;
  resolveWorkspaceId(scope: string): Promise<string | null>;
}

export type TerminalCommandObservationRuntime = {
  observeTerminalCommand(event: TerminalCommandEvent, target?: ThreadObservationIdentity): Promise<boolean>;
};

/** The application-host adapter preserves the projector's target Thread. */
export const createTerminalCommandObserveAdapter = (
  runtime: TerminalCommandObservationRuntime,
): TerminalCommandProjectorDeps["observe"] => (
  (event, target) => runtime.observeTerminalCommand(event, target)
);

export function createTerminalCommandProjector(deps: TerminalCommandProjectorDeps) {
  const project = async (record: TerminalCommandRecord): Promise<TerminalCommandProjectionResult> => {
    if (record.owner !== "user") return {};
    const cwd = record.cwd ?? deps.inspectCwd?.(record.terminalId);
    if (!cwd) return {};
    let workspaceId: string | null;
    try {
      workspaceId = await deps.resolveWorkspaceId(cwd);
    } catch (error) {
      deps.onError?.(error);
      return {};
    }
    if (!workspaceId) return {};
    const event: TerminalCommandEvent = {
      workspaceId,
      sessionId: record.terminalId,
      command: record.command,
      commandId: record.commandId,
      exitCode: record.exitCode,
      source: "user",
      integration: record.integration,
      endedAt: record.endedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      cwd,
    };
    const targets = [...new Map((await deps.listBoundOwners(workspaceId)).map(owner => [owner.runId, owner])).values()];
    if (targets.length === 0) return {};
    const inserted = await Promise.all(targets.map(async (target) => {
      try {
        return {
          runId: target.runId,
          inserted: await deps.observe(event, target),
        };
      } catch (error) {
        deps.onError?.(error);
        return { runId: target.runId, inserted: false };
      }
    }));
    try {
      await deps.drain();
    } catch (error) {
      deps.onError?.(error);
      return Object.fromEntries(inserted.map(({ runId, inserted: wasInserted }) => [runId, wasInserted]));
    }
    return Object.fromEntries(inserted.map(({ runId, inserted: wasInserted }) => [runId, wasInserted]));
  };

  return { project };
}
