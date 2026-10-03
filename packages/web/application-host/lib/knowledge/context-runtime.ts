import type { DocumentMutationObservation } from "../documents/authority.js";
import { waitWithSignal } from "../cancellation.js";
import type { Zone2ContextUsage, Zone2Knowledge, Zone2Material, Zone2ShellCompletion } from "../harness/zone2.js";
import type { ShellCommandCompletedEvent, ShellCommandOutputEvent, ShellCommandStartedEvent } from "../harness/shell-supervisor.js";
import { createObservers, type DiagnosticEvent, type GitStatusEvent, type Observers, type TerminalCommandEvent, type TerminalExitEvent } from "./observers.js";
import { terminalCommandDedupeKey, type KnowledgeScope, type KnowledgeStore, type RecallResult, type StoredEvent } from "./store.js";

interface SessionBinding {
  gitFingerprint: string | null;
  observers: Promise<Observers | null> | null;
  pendingUserPaths: Set<string>;
  sessionId: string;
  tail: Promise<void>;
  turnIndex: number;
  workspaceId: string;
  recallCache: {
    query: string;
    workspaceRevision: string;
    userRevision: string | null;
    sessionRevision: string | null;
    results: RecallResult[];
  } | null;
}

export interface KnowledgeContextRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  /** Optional user store used by cross-scope recall (owner and user IDs overlap). */
  getUserStore?: () => Promise<KnowledgeStore | null>;
  getSessionStore?: (sessionId: string) => Promise<KnowledgeStore | null>;
  resolveScope?: (sessionId: string) => Promise<string>;
  /**
   * BC3: the goal the session is working toward (owning thread brief). When
   * present it joins the latest user message as the recall query, so a
   * continuation like "keep going" still retrieves the work's memories.
   */
  goalForSession?: (sessionId: string) => Promise<string | undefined>;
  recall?: (input: {
    workspaceId: string;
    store: KnowledgeStore;
    sessionId: string;
    query: string;
    goal?: string;
    signal?: AbortSignal;
  }) => Promise<RecallResult[]>;
  onError?: (error: unknown) => void;
}

export interface Zone2MaterialRequest {
  afterEventId?: number;
  contextUsage: Zone2ContextUsage | null;
  query?: string;
  knownMaterial?: Record<string, string>;
  observedShellExecutions?: string[];
  /** Receipts still present in the Pi input after a delivery/compaction retry. */
  retainedObservationRefs?: string[];
  signal?: AbortSignal;
  sessionId: string;
  sinceTurn: number;
  /** Branch entry IDs for ancestor-resolution block filtering. */
  branchEntryIds?: string[];
}

export interface Zone2MaterialResult {
  eventCursor: number;
  material: Zone2Material;
  shellCompletions?: string[];
}

export interface DurableShellEvent {
  id: number;
  type: "shell-start" | "shell-output" | "shell-completion";
  sessionId: string;
  workspaceId: string;
  executionId: string;
  at: number;
  state: "running" | "completed" | "failed" | "cancelled";
  command: string;
  cwd: string;
  offset?: number;
  text?: string;
  exitCode?: number | null;
}

const emptyMaterial = (contextUsage: Zone2ContextUsage | null): Zone2Material => ({
  userEdits: [],
  userCommands: [],
  newDiagnostics: [],
  git: null,
  knowledge: [],
  blocks: [],
  contextUsage,
});

const isAgentOwner = (kind: string): boolean => (
  kind === "pi-worker" || kind.startsWith("harness-")
);

const dataOf = (event: StoredEvent): Record<string, unknown> => event.data ?? {};

export function createKnowledgeContextRuntime(options: KnowledgeContextRuntimeOptions) {
  const sessions = new Map<string, SessionBinding>();
  const pending = new Set<Promise<void>>();
  const seenCommandIds = new Set<string>();
  const shellListeners = new Set<(event: DurableShellEvent) => void | Promise<void>>();
  let disposed = false;

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => options.onError?.(error)).finally(() => pending.delete(task));
  };

  const bindSession = (sessionId: string, workspaceId: string): void => {
    const current = sessions.get(sessionId);
    if (current?.workspaceId === workspaceId) return;
    const prefix = `terminal-command:[${JSON.stringify(sessionId)},`;
    for (const key of seenCommandIds) {
      if (key.startsWith(prefix)) seenCommandIds.delete(key);
    }
    sessions.set(sessionId, {
      observers: null,
      gitFingerprint: null,
      pendingUserPaths: new Set(),
      sessionId,
      tail: current?.tail ?? Promise.resolve(),
      turnIndex: current?.turnIndex ?? 0,
      workspaceId,
      recallCache: null,
    });
  };

  const observersFor = async (binding: SessionBinding): Promise<Observers | null> => {
    if (binding.observers) return binding.observers;
    const loading = options.getStore(binding.workspaceId).then((store) => (
      store ? createObservers({ store, sessionId: binding.sessionId }) : null
    ));
    binding.observers = loading;
    void loading.catch(() => {
      if (binding.observers === loading) binding.observers = null;
    });
    return loading;
  };

  const forWorkspace = (
    workspaceId: string,
    visit: (observers: Observers, binding: SessionBinding) => Promise<void>,
    targetSessionId?: string,
  ): Promise<void> => Promise.all([...sessions.values()]
    .filter((binding) => (
      binding.workspaceId === workspaceId
      && (targetSessionId === undefined || binding.sessionId === targetSessionId)
    ))
    .map((binding) => {
      const task = binding.tail.then(async () => {
        const observers = await observersFor(binding);
        if (observers) await visit(observers, binding);
      });
      binding.tail = task.catch(() => undefined);
      return task;
    }))
    .then(() => undefined);

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const agentWriterActive = isAgentOwner(event.owner.kind);
    track(forWorkspace(event.workspaceId, (observers, binding) => {
      if (agentWriterActive) binding.pendingUserPaths.delete(event.resourceId);
      else binding.pendingUserPaths.add(event.resourceId);
      return observers.onDocumentWrite({
        workspaceId: event.workspaceId,
        path: event.resourceId,
        kind: event.kind,
        agentWriterActive,
        turnIndex: binding.turnIndex,
      });
    }));
  };

  const persistTerminalObservation = async (
    event: TerminalExitEvent,
    targetSessionId?: string,
  ): Promise<boolean> => {
    if (disposed) return false;
    let inserted = false;
    const task = forWorkspace(event.workspaceId, async (observers, binding) => {
      const seenKey = event.commandId
        ? terminalCommandDedupeKey(binding.sessionId, event.commandId)
        : undefined;
      // This check belongs inside the per-session FIFO. A failed putEvent must
      // leave the key absent so a later delivery can retry the durable write.
      if (seenKey && seenCommandIds.has(seenKey)) return;
      const wrote = await observers.onTerminalExit({
        ...event,
        turnIndex: binding.turnIndex,
      });
      if (wrote) {
        if (seenKey) seenCommandIds.add(seenKey);
        inserted = true;
      }
    }, targetSessionId);
    track(task);
    await task;
    return inserted;
  };

  const observeTerminalExit = (event: TerminalExitEvent): Promise<boolean> => persistTerminalObservation(event);

  const observeTerminalCommand = (
    event: TerminalCommandEvent,
    targetSessionId?: string,
  ): Promise<boolean> => persistTerminalObservation(event, targetSessionId);

  const persistShellEvent = async (
    sessionId: string,
    event: ShellCommandStartedEvent | ShellCommandOutputEvent | ShellCommandCompletedEvent,
    type: DurableShellEvent["type"],
  ): Promise<DurableShellEvent | null> => {
    if (disposed) return null;
    const binding = sessions.get(sessionId);
    if (!binding) return null;
    if (type === "shell-output") {
      const output = event as ShellCommandOutputEvent;
      const transient: DurableShellEvent = {
        id: 0,
        type,
        sessionId,
        workspaceId: binding.workspaceId,
        executionId: event.executionId,
        at: output.at,
        state: "running",
        command: event.command,
        cwd: event.cwd,
        offset: output.offset,
        text: output.text,
      };
      // Raw shell output remains in the terminal/output owner. Follow-up
      // observers may persist a compact match fact before advancing their own
      // cursor; the Knowledge event store never becomes a duplicate log spool.
      await Promise.all([...shellListeners].map((listener) => listener(transient)));
      return transient;
    }
    let durable: DurableShellEvent | null = null;
    const task = binding.tail.then(async () => {
      const store = await options.getStore(binding.workspaceId);
      if (!store) return;
      const completed = type === "shell-completion" ? event as ShellCommandCompletedEvent : null;
      const result = await store.putEvent({
        kind: "command",
        at: completed?.endedAt ?? event.startedAt,
        sessionId,
        turnIndex: binding.turnIndex,
        text: event.command,
        source: "agent",
        dedupeKey: type === "shell-start"
          ? `shell-start:${event.executionId}`
          : `shell-completion:${event.executionId}`,
        data: {
          type,
          executionId: event.executionId,
          commandRunId: event.commandRunId,
          command: event.command,
          cwd: event.cwd,
          startedAt: event.startedAt,
          ...(completed ? {
            exitCode: completed.exitCode,
            cancelled: completed.cancelled,
            endedAt: completed.endedAt,
            ...(completed.outputHandle === undefined ? {} : { outputHandle: completed.outputHandle }),
          } : {}),
        },
      });
      const state = completed
        ? completed.cancelled ? "cancelled" : completed.exitCode === 0 ? "completed" : "failed"
        : "running";
      durable = {
        id: result.id,
        type,
        sessionId,
        workspaceId: binding.workspaceId,
        executionId: event.executionId,
        at: completed?.endedAt ?? event.startedAt,
        state,
        command: event.command,
        cwd: event.cwd,
        ...(completed ? { exitCode: completed.exitCode, ...(completed.outputPreview === undefined ? {} : { text: completed.outputPreview }) } : {}),
      };
      await Promise.all([...shellListeners].map((listener) => listener(durable!)));
    });
    binding.tail = task.catch(() => undefined);
    track(task);
    await task;
    return durable;
  };

  const observeShellStarted = (sessionId: string, event: ShellCommandStartedEvent): Promise<DurableShellEvent | null> => (
    persistShellEvent(sessionId, event, "shell-start")
  );

  const observeShellOutput = (sessionId: string, event: ShellCommandOutputEvent): Promise<DurableShellEvent | null> => (
    persistShellEvent(sessionId, event, "shell-output")
  );

  const observeShellCompletion = (sessionId: string, event: ShellCommandCompletedEvent): Promise<DurableShellEvent | null> => (
    persistShellEvent(sessionId, event, "shell-completion")
  );

  const shellEvents = async (
    workspaceId: string,
    sessionId: string,
    executionId: string,
    afterId = 0,
  ): Promise<DurableShellEvent[]> => {
    const store = await options.getStore(workspaceId);
    if (!store) return [];
    const events = await store.listEvents({ sessionId, afterId });
    return events.flatMap((stored): DurableShellEvent[] => {
      const data = dataOf(stored);
      if (data.executionId !== executionId
        || (data.type !== "shell-start" && data.type !== "shell-output" && data.type !== "shell-completion")) return [];
      const type = data.type;
      const exitCode = typeof data.exitCode === "number" || data.exitCode === null ? data.exitCode : undefined;
      const cancelled = data.cancelled === true;
      return [{
        id: stored.id,
        type,
        sessionId,
        workspaceId,
        executionId,
        at: stored.at,
        state: type === "shell-completion"
          ? cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed"
          : "running",
        command: typeof data.command === "string" ? data.command : stored.text,
        cwd: typeof data.cwd === "string" ? data.cwd : "",
        ...(typeof data.offset === "number" ? { offset: data.offset } : {}),
        ...(typeof data.text === "string" ? { text: data.text } : {}),
        ...(exitCode === undefined ? {} : { exitCode }),
      }];
    });
  };

  const subscribeShellEvents = (listener: (event: DurableShellEvent) => void | Promise<void>): (() => void) => {
    shellListeners.add(listener);
    return () => shellListeners.delete(listener);
  };

  const observeDiagnostics = (event: DiagnosticEvent): void => {
    if (disposed) return;
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      // A diagnostic enters Zone 2 only when it follows a user-authored
      // document mutation. Agent-authored diagnostics are already visible in
      // tool results and must not be repeated as "news" on the next turn.
      if (!binding.pendingUserPaths.delete(event.path)) return;
      await observers.onDiagnostics({
        ...event,
        turnIndex: binding.turnIndex,
      });
    }));
  };

  const observeGitStatus = (event: GitStatusEvent): void => {
    if (disposed) return;
    const fingerprint = JSON.stringify([event.branch ?? null, event.changed ?? null, event.note ?? null]);
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      if (binding.gitFingerprint === fingerprint) return;
      await observers.onGitStatus({
        ...event,
        turnIndex: binding.turnIndex,
      });
      binding.gitFingerprint = fingerprint;
    }));
  };

  const zone2Material = async (request: Zone2MaterialRequest): Promise<Zone2MaterialResult> => {
    request.signal?.throwIfAborted();
    const wait = <T>(work: Promise<T>): Promise<T> => waitWithSignal(work, request.signal);
    if (options.resolveScope) bindSession(request.sessionId, await wait(options.resolveScope(request.sessionId)));
    const binding = sessions.get(request.sessionId);
    if (!binding) {
      return { eventCursor: request.afterEventId ?? 0, material: emptyMaterial(request.contextUsage) };
    }
    binding.turnIndex = Math.max(binding.turnIndex, request.sinceTurn + 1);
    // A document commit deliberately does not wait for observational storage.
    // The next model turn is the synchronization point: include every event
    // already queued for this session before advancing its cursor.
    await wait(binding.tail);
    const store = await wait(options.getStore(binding.workspaceId));
    if (!store) {
      return { eventCursor: request.afterEventId ?? 0, material: emptyMaterial(request.contextUsage) };
    }
    const events = await wait(store.listEvents({
      sessionId: request.sessionId,
      ...(request.afterEventId === undefined
        ? { minTurnIndex: request.sinceTurn }
        : { afterId: request.afterEventId }),
    }));
    const material = emptyMaterial(request.contextUsage);
    const shellCompletions: string[] = [];
    const observedShellExecutions = new Set(request.observedShellExecutions ?? []);
    let eventCursor = request.afterEventId ?? 0;
    for (const event of events) {
      eventCursor = Math.max(eventCursor, event.id);
      const data = dataOf(event);
      if (event.kind === "edit" && event.source !== "agent") {
        const kind = data.kind;
        const path = data.path ?? event.refs?.path;
        if ((kind === "modified" || kind === "created" || kind === "deleted") && typeof path === "string") {
          material.userEdits.push({ kind, path });
        }
      } else if (event.kind === "command" && data.type === "shell-completion") {
        const executionId = data.executionId;
        if (typeof executionId === "string" && !observedShellExecutions.has(executionId)) {
          const command = data.command;
          const cwd = data.cwd;
          const exitCode = data.exitCode;
          const cancelled = data.cancelled;
          if (typeof command === "string" && typeof cwd === "string"
            && (typeof exitCode === "number" || exitCode === null)
            && typeof cancelled === "boolean") {
            (material.shellCompletions ??= []).push({
              executionId,
              command,
              cwd,
              exitCode,
              cancelled,
              endedAt: typeof data.endedAt === "number" ? data.endedAt : event.at,
              ...(typeof data.outputHandle === "string" ? { outputHandle: data.outputHandle } : {}),
            } satisfies Zone2ShellCompletion);
            shellCompletions.push(executionId);
          }
        }
      } else if (event.kind === "command" && event.source !== "agent") {
        const command = data.command;
        const exitCode = data.exitCode;
        if (typeof command === "string" && typeof exitCode === "number") {
          material.userCommands.push({
            command,
            exitCode,
            at: event.at,
            ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}),
          });
        }
      } else if (event.kind === "diagnostic" && event.source !== "agent") {
        const path = data.path ?? event.refs?.path;
        const count = data.count;
        const worst = data.worst;
        if (typeof path === "string" && typeof count === "number" && (worst === "error" || worst === "warning")) {
          material.newDiagnostics.push({ path, count, worst });
        }
      } else if (event.kind === "source" && data.type === "git") {
        material.git = {
          ...(typeof data.branch === "string" ? { branch: data.branch } : {}),
          ...(typeof data.changed === "number" ? { changed: data.changed } : {}),
          ...(typeof data.note === "string" ? { note: data.note } : {}),
        };
      }
    }
    material.blocks = (await wait(store.getBlocks(
      request.sessionId,
      request.branchEntryIds === undefined ? undefined : request.branchEntryIds,
    ))).map((block) => ({
      label: block.label,
      content: block.content,
    }));
    material.blocksComplete = true;
    const query = request.query?.trim();
    const goal = options.goalForSession
      ? await wait(options.goalForSession(request.sessionId).catch(() => undefined))
      : undefined;
    // BC3: the recall query carries the owning work's goal plus the latest
    // message, so "continue" still reaches the memories bound to that work.
    const recallQuery = [goal, query].filter((part) => part !== undefined && part.length > 0).join("\n") || undefined;
    const retainedKnowledge = Object.keys(request.knownMaterial ?? {}).flatMap((key) => {
      const match = /^knowledge:(workspace|user|bot|session):(\d+)$/.exec(key);
      if (!match) return [];
      return [{ scope: match[1] as KnowledgeScope, id: Number(match[2]) }];
    });
    const userStore = (recallQuery || retainedKnowledge.length > 0) && options.getUserStore
      ? await wait(options.getUserStore())
      : null;
    // Owner-scope rows (workspace/bot/session) live in `store`; only `user`
    // rows resolve against the user store.
    const sessionStore = options.getSessionStore ? await wait(options.getSessionStore(request.sessionId)) : null;
    const storeForScope = (scope: KnowledgeScope) => scope === "user" ? userStore
      : scope === "session" && sessionStore ? sessionStore : store;
    if (retainedKnowledge.length > 0) {
      const invalidations = (await wait(Promise.all(retainedKnowledge.map(async ({ scope, id }) => {
        const source = storeForScope(scope);
        if (!source) return [];
        const current = await wait(source.getKnowledge(id));
        return !current || current.scope !== scope || current.invalidAt !== undefined || current.status !== "accepted"
          ? [{ id, scope }]
          : [];
      })))).flat();
      if (invalidations.length > 0) {
        (material as Zone2Material & { knowledgeInvalidations: typeof invalidations }).knowledgeInvalidations = invalidations;
      }
    }
    if (recallQuery) {
      // Recall is a query operation, not a per-request poll. Store-owned
      // knowledge revisions invalidate the cache in O(1), while the cached
      // RecallResult retains its source scope/payload (workspace and user
      // stores may legally reuse numeric node IDs).
      const workspaceRevision = store.knowledgeRevision();
      const userRevision = userStore ? userStore.knowledgeRevision() : null;
      const sessionRevision = sessionStore ? sessionStore.knowledgeRevision() : null;
      const cached = binding.recallCache;
      const sameQuery = cached?.query === recallQuery;
      const revisionsChanged = !cached
        || cached.workspaceRevision !== workspaceRevision
        || cached.userRevision !== userRevision || cached.sessionRevision !== sessionRevision;
      if (sameQuery && revisionsChanged) {
        const invalidations = (await wait(Promise.all(cached.results.flatMap(async (result) => {
          if (result.node.type !== "knowledge") return [];
          const payload = result.node.payload;
          const scope = payload.scope as KnowledgeScope;
          const source = storeForScope(scope);
          if (!source) return [];
          const current = await wait(source.getKnowledge(result.node.id));
          return !current || current.invalidAt !== undefined || current.status !== "accepted"
            ? [{ id: result.node.id, scope }]
            : [];
        })))).flat();
        if (invalidations.length > 0) {
          // Preserve this explicit fact on the material object until the
          // formatter/receipt selector has represented it in history.
          const prior = material.knowledgeInvalidations ?? [];
          (material as Zone2Material & { knowledgeInvalidations: typeof invalidations }).knowledgeInvalidations = [...prior, ...invalidations];
        }
      }
      let recalled: RecallResult[];
      if (cached?.query === recallQuery
        && cached.workspaceRevision === workspaceRevision
        && cached.userRevision === userRevision && cached.sessionRevision === sessionRevision) {
        recalled = cached.results;
      } else {
        recalled = options.recall
          ? await wait(options.recall({
              workspaceId: binding.workspaceId,
              store,
              sessionId: request.sessionId,
              query: recallQuery,
              ...(goal !== undefined ? { goal } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
            }))
          : await wait(store.recall(recallQuery, 5));
        request.signal?.throwIfAborted();
        binding.recallCache = { query: recallQuery, workspaceRevision, userRevision, sessionRevision, results: recalled };
      }
      material.knowledge = recalled.flatMap((result) => {
        if (result.node.type !== "knowledge") return [];
        const content = result.node.payload.content;
        const trigger = result.node.payload.trigger;
        return typeof content === "string" && typeof trigger === "string"
          ? [{
              id: result.node.id,
              title: content,
              trigger,
              ...(typeof result.node.payload.nature === "string" ? { nature: result.node.payload.nature } : {}),
              ...(result.node.payload.source && typeof result.node.payload.source === "object"
                ? { sourceKind: String((result.node.payload.source as { kind?: string }).kind ?? "") } : {}),
              ...(typeof result.node.payload.scope === "string"
                ? { scope: result.node.payload.scope as NonNullable<Zone2Knowledge["scope"]> }
                : {}),
            }]
          : [];
      });
    }
    // A human-corrected or organizer-superseded row reaches the request as an
    // explicit update, not as another invalidation (BC3): the accepted
    // successor is delivered beside the removal.
    const deliveredInvalidations = material.knowledgeInvalidations ?? [];
    if (deliveredInvalidations.length > 0) {
      const corrections = (await wait(Promise.all(deliveredInvalidations.map(async ({ scope, id }) => {
        const source = storeForScope(scope);
        if (!source) return [];
        const chain = await wait(source.getSupersedeChain(id, scope).catch(() => null));
        const successor = chain?.successors
          .filter((item) => item.status === "accepted" && item.invalidAt === undefined)
          .at(-1);
        return successor ? [{ id: successor.id, scope, supersedes: id, title: successor.content, trigger: successor.trigger,
          ...(successor.nature ? { nature: successor.nature } : {}), ...(successor.source ? { sourceKind: successor.source.kind } : {}) }] : [];
      })))).flat();
      if (corrections.length > 0) material.knowledgeCorrections = corrections;
    }
    return { eventCursor, material, ...(shellCompletions.length > 0 ? { shellCompletions } : {}) };
  };

  const dropSession = (sessionId: string): void => {
    sessions.delete(sessionId);
    const prefix = `terminal-command:[${JSON.stringify(sessionId)},`;
    for (const key of seenCommandIds) {
      if (key.startsWith(prefix)) seenCommandIds.delete(key);
    }
  };

  const resetSessionObservationBaselines = (sessionId: string): void => {
    const binding = sessions.get(sessionId);
    if (binding) binding.gitFingerprint = null;
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    sessions.clear();
    shellListeners.clear();
    await drain();
  };

  return {
    bindSession,
    dispose,
    drain,
    dropSession,
    observeDiagnostics,
    observeDocumentMutation,
    listBoundSessions: (workspaceId: string): string[] => (
      [...sessions.values()].filter((binding) => binding.workspaceId === workspaceId).map((binding) => binding.sessionId)
    ),
    observeGitStatus,
    observeTerminalCommand,
    observeTerminalExit,
    observeShellCompletion,
    observeShellOutput,
    observeShellStarted,
    shellEvents,
    subscribeShellEvents,
    resetSessionObservationBaselines,
    zone2Material,
  };
}

export type KnowledgeContextRuntime = ReturnType<typeof createKnowledgeContextRuntime>;
