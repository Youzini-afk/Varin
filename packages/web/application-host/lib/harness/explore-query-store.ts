import { randomUUID } from "node:crypto";
import type {
  AgentInputContext,
  HarnessActorIdentity,
  HarnessResolvedFastDecisionBinding,
  HarnessExploreDecisionMode,
} from "@varin/protocol";
import {
  createExploreQueryRun,
  type ExploreDeps,
  type ExploreInput,
  type ExploreQueryRun,
} from "./explore.js";
import {
  exploreQueryActorsMatch,
  type ExploreQueryActor,
} from "./explore-query-identity.js";

export interface StoredExploreQuery {
  id: string;
  actor: ExploreQueryActor;
  sessionId: string;
  workspaceId: string | null;
  inputContext: AgentInputContext;
  paths?: string[];
  startedAt: number;
  deadlineAt: number;
  decisionMode?: HarnessExploreDecisionMode;
  duties?: NonNullable<import('@varin/protocol').ExploreQueryStartResult['duties']>;
  rerankSettings?: import('@varin/protocol').HarnessRerankSettings;
  rerankInvalid?: boolean;
  controller: AbortController;
  /** User/request cancellation and the total query deadline; sources have their own controller. */
  cancelController: AbortController;
  run: ExploreQueryRun;
  finishing?: Promise<ReturnType<ExploreQueryRun["finish"]>>;
  /** One delivered pack/OutputStore identity for concurrent or repeated finish calls. */
  packed?: Promise<import("@varin/protocol").ExploreQueryFinishResult>;
  /**
   * Fast-decision binding frozen when the query started (D-312). The
   * progressive loop launches with the query while this stays `ready`; a
   * settings edit applies to the next query, never a live one.
   */
  fastDecision?: {
    status: "ready" | "disabled" | "unconfigured" | "invalid" | "unavailable";
    /** Frozen resolved binding — carries the credential-free configurationId. */
    binding?: HarnessResolvedFastDecisionBinding;
    /** `finish` asks the loop to stop offering actions and settle. */
    requestSettle?: () => void;
    /** Grace expired at finish: abort the loop's own signal. */
    abort?: () => void;
    /** Resolves after the loop applied its details onto the run. */
    done?: Promise<void>;
    /** The loop's final report; also applied onto the run for `finish`. */
    details?: import("@varin/protocol").ExploreFastDecisionDetails;
  };
}

export interface ExploreQueryStoreStart {
  actor: ExploreQueryActor;
  inputContext: AgentInputContext;
  input: ExploreInput;
  deps: ExploreDeps;
  deadlineAt: number;
  reserveForJudgeMs?: number;
  /** Single abort for this query: model waiters, rg, read, structure, graph, semantic. */
  controller: AbortController;
}

export interface ExploreQueryStore {
  start(request: ExploreQueryStoreStart): StoredExploreQuery;
  get(sessionId: string, queryId: string): StoredExploreQuery | undefined;
  cancel(actor: HarnessActorIdentity & { workspaceId?: string | null }, queryId: string): boolean;
  release(actor: HarnessActorIdentity & { workspaceId?: string | null }, queryId: string): boolean;
  dropSession(sessionId: string): void;
  dispose(): void;
}

export function createExploreQueryStore(): ExploreQueryStore {
  const queries = new Map<string, StoredExploreQuery>();

  const keyOf = (sessionId: string, queryId: string): string => `${sessionId}:${queryId}`;

  const start = (request: ExploreQueryStoreStart): StoredExploreQuery => {
    const id = `eq_${randomUUID()}`;
    const controller = request.controller;
    const cancelController = new AbortController();
    cancelController.signal.addEventListener("abort", () => {
      if (!controller.signal.aborted) controller.abort(cancelController.signal.reason);
    }, { once: true });
    const run = createExploreQueryRun(request.input, request.deps, {
      deadlineAt: request.deadlineAt,
      ...(request.reserveForJudgeMs !== undefined ? { reserveForJudgeMs: request.reserveForJudgeMs } : {}),
      controller,
    });
    const stored: StoredExploreQuery = {
      id,
      actor: request.actor,
      sessionId: request.actor.sessionId,
      workspaceId: request.actor.workspaceId,
      inputContext: request.inputContext,
      ...(request.input.paths ? { paths: request.input.paths } : {}),
      startedAt: Date.now(),
      deadlineAt: request.deadlineAt,
      controller,
      cancelController,
      run,
    };
    queries.set(keyOf(request.actor.sessionId, id), stored);
    const sourceDeadlineAt = request.deadlineAt - (request.reserveForJudgeMs ?? 0);
    const deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
    }, Math.max(0, sourceDeadlineAt - Date.now()));
    controller.signal.addEventListener("abort", () => clearTimeout(deadlineTimer), { once: true });
    const totalDeadlineTimer = setTimeout(() => {
      if (!cancelController.signal.aborted) cancelController.abort();
    }, Math.max(0, request.deadlineAt - Date.now()));
    cancelController.signal.addEventListener("abort", () => clearTimeout(totalDeadlineTimer), { once: true });
    run.start();
    return stored;
  };

  const get = (sessionId: string, queryId: string): StoredExploreQuery | undefined => (
    queries.get(keyOf(sessionId, queryId))
  );

  const requireOwned = (
    actor: HarnessActorIdentity & { workspaceId?: string | null },
    queryId: string,
  ): StoredExploreQuery | undefined => {
    const stored = get(actor.sessionId, queryId);
    if (!stored || !exploreQueryActorsMatch(stored.actor, actor)) return undefined;
    return stored;
  };

  const cancel = (actor: HarnessActorIdentity & { workspaceId?: string | null }, queryId: string): boolean => {
    const stored = requireOwned(actor, queryId);
    if (!stored) return false;
    stored.run.cancel();
    if (!stored.controller.signal.aborted) stored.controller.abort();
    if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
    return true;
  };

  const release = (actor: HarnessActorIdentity & { workspaceId?: string | null }, queryId: string): boolean => {
    const stored = requireOwned(actor, queryId);
    if (!stored) return false;
    if (stored.run.terminal() === "active") stored.run.cancel();
    if (!stored.controller.signal.aborted) stored.controller.abort();
    if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
    queries.delete(keyOf(actor.sessionId, queryId));
    return true;
  };

  const dropSession = (sessionId: string): void => {
    for (const [key, stored] of queries) {
      if (stored.sessionId !== sessionId) continue;
      stored.run.cancel();
      if (!stored.controller.signal.aborted) stored.controller.abort();
      if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
      queries.delete(key);
    }
  };

  const dispose = (): void => {
    for (const stored of queries.values()) {
      stored.run.cancel();
      if (!stored.controller.signal.aborted) stored.controller.abort();
      if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
    }
    queries.clear();
  };

  return { start, get, cancel, release, dropSession, dispose };
}
