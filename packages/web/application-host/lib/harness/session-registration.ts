import type { HarnessActorIdentity, PiSettingsSnapshot } from "@varin/protocol";
import type { HarnessServiceHost, HarnessSessionContext } from "./service-host.js";
import { HarnessShellSettingsError, resolveHarnessShellSetting } from "./harness-shell-settings.js";
import { resolveHarnessWebBinding } from "./harness-web-settings.js";
import { waitWithSignal } from "../knowledge/semantic/cancellation.js";
import { HarnessServiceError } from "./service-error.js";

const sameGeneration = (a: HarnessActorIdentity, b: HarnessActorIdentity): boolean => (
  a.authorityInstanceId === b.authorityInstanceId && a.sessionId === b.sessionId
  && a.workerId === b.workerId && a.workerGeneration === b.workerGeneration
);

/** Shell discovery/settings may be asynchronous; actor admission must wait for that exact generation. */
export function createHarnessSessionRegistration(options: {
  host: Pick<HarnessServiceHost, "registerSession" | "dropSession" | "hasActor" | "resolveActor" | "getInterpreter">;
  readSettings(context: HarnessSessionContext): Promise<PiSettingsSnapshot>;
  /** Resolve the authorized workspace root for seeding the work context (RR2). */
  resolveWorkspaceRoot?: (workspaceId: string) => Promise<string | null>;
}) {
  const pending = new Map<string, { actor: HarnessActorIdentity; controller: AbortController; promise: Promise<void> }>();
  let disposed = false;

  const register = (context: HarnessSessionContext): Promise<void> => {
    if (disposed) return Promise.resolve();
    const previous = pending.get(context.actor.sessionId);
    if (previous && sameGeneration(previous.actor, context.actor)) return previous.promise;
    if (!previous && options.host.hasActor(context.actor)) return Promise.resolve();
    previous?.controller.abort();
    // Replacing an actor revokes the old generation before waiting on configuration.
    if (previous || options.host.getInterpreter(context.actor.sessionId) !== null) {
      options.host.dropSession(context.actor.sessionId);
    }
    const entry = { actor: { ...context.actor }, controller: new AbortController(), promise: Promise.resolve() };
    pending.set(context.actor.sessionId, entry);
    entry.promise = (async () => {
      let resolved: Pick<HarnessSessionContext, "shellSetting" | "shellResolution" | "webBinding">;
      try {
        const settings = await waitWithSignal(options.readSettings(context), entry.controller.signal);
        resolved = {
          shellSetting: resolveHarnessShellSetting(settings),
          webBinding: resolveHarnessWebBinding(settings),
        };
      } catch (error) {
        if (entry.controller.signal.aborted) return;
        resolved = { shellResolution: { invalid: {
          reason: error instanceof HarnessShellSettingsError ? error.message : "Shell settings are unavailable",
          hint: error instanceof HarnessShellSettingsError
            ? "Set harness.shell to auto, git-bash, powershell, or wsl in Pi settings.json."
            : "Restore access to Pi settings and reopen this session to initialize its shell.",
        } } };
      }
      if (disposed || entry.controller.signal.aborted || pending.get(context.actor.sessionId) !== entry) return;
      const authorityWorkspaceRoot = context.workspaceId && options.resolveWorkspaceRoot
        ? await waitWithSignal(options.resolveWorkspaceRoot(context.workspaceId), entry.controller.signal)
        : context.authorityWorkspaceRoot;
      if (context.workspaceId && options.resolveWorkspaceRoot && !authorityWorkspaceRoot) {
        throw new HarnessServiceError("unavailable", "Workspace authority root could not be resolved; session admission was not committed");
      }
      if (disposed || entry.controller.signal.aborted || pending.get(context.actor.sessionId) !== entry) return;
      options.host.registerSession({
        ...context,
        actor: entry.actor,
        ...resolved,
        ...(authorityWorkspaceRoot ? { authorityWorkspaceRoot } : {}),
      });
    })().finally(() => {
      if (pending.get(context.actor.sessionId) === entry) pending.delete(context.actor.sessionId);
    });
    return entry.promise;
  };

  const hasActor = (identity: HarnessActorIdentity): boolean => {
    const entry = pending.get(identity.sessionId);
    return !disposed && (entry ? sameGeneration(entry.actor, identity) : options.host.hasActor(identity));
  };

  const resolveActor = async (identity: HarnessActorIdentity, signal?: AbortSignal) => {
    if (disposed) return null;
    const entry = pending.get(identity.sessionId);
    if (entry) {
      if (!sameGeneration(entry.actor, identity)) return null;
      await waitWithSignal(entry.promise, signal);
    }
    if (!hasActor(identity)) return null;
    const actor = await options.host.resolveActor(identity);
    return hasActor(identity) ? actor : null;
  };

  const dropSession = (sessionId: string, identity?: HarnessActorIdentity): void => {
    const entry = pending.get(sessionId);
    if (entry && (!identity || sameGeneration(entry.actor, identity))) {
      pending.delete(sessionId);
      entry.controller.abort();
    }
    options.host.dropSession(sessionId, identity);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    const tasks = [...pending.values()];
    for (const entry of tasks) entry.controller.abort();
    pending.clear();
    await Promise.allSettled(tasks.map((entry) => entry.promise));
  };

  return { register, resolveActor, hasActor, dropSession, dispose };
}
