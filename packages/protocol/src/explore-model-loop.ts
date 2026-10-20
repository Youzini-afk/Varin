import type {
  ExploreGroupedSearchPlan,
  ExploreModelParticipation,
  ExploreModelStageStatus,
  ExploreProgressPhase,
  ExploreQueryFollowupParams,
  ExploreQueryFollowupResult,
  ExploreQueryPlanResult,
  ExploreQuerySelectResult,
  ExploreQuerySelectionGroup,
  ExploreQuerySourceState,
  ExploreQueryStartResult,
  ExploreQueryView,
  ExploreQueryViewsResult,
} from "./harness.js";
import type { HarnessExploreDecisionMode } from "./harness-settings.js";
import { partitionExploreViews, ExploreEvidenceChanged } from './explore-context.js';
import {
  EXPLORE_PLAN_SYSTEM,
  EXPLORE_SELECT_SYSTEM,
  exploreShouldPlanWithModel,
  exploreShouldSelectWithModel,
  parseExplorePlan,
  parseExploreSelection,
  renderExplorePlanPrompt,
  renderExploreSelectPrompt,
} from "./explore-model.js";

export type ExploreModelComplete = ((input: {
  systemPrompt: string;
  user: string;
  signal?: AbortSignal;
  materials?: ExploreQueryView[];
}) => Promise<string>) & {
  fitsInput?(input: { systemPrompt: string; user: string }): Promise<boolean>;
};

/** The query owner validates all source identities, ranges and scope. */
export interface ExploreModelLoopPort {
  plan(plan: ExploreGroupedSearchPlan): Promise<ExploreQueryPlanResult>;
  views(options: { seen?: string[] }): Promise<ExploreQueryViewsResult>;
  wait(afterSequence: number): Promise<unknown>;
  select(groups: ExploreQuerySelectionGroup[]): Promise<ExploreQuerySelectResult>;
  followup(request: Omit<ExploreQueryFollowupParams, "queryId">): Promise<ExploreQueryFollowupResult>;
  deliver?(): void;
  retained?(): ExploreQueryView[];
}

/** Resolve already-checked capabilities once; an explicit mode never cascades. */
export function resolveExploreDuties(options: {
  mode: HarnessExploreDecisionMode;
  llm: boolean;
  fastDecision: boolean;
  rerank: boolean;
}): NonNullable<ExploreQueryStartResult["duties"]> {
  const llm = options.llm && (options.mode === "auto" || options.mode === "llm");
  const fastDecision = options.fastDecision && (options.mode === "auto" || options.mode === "fast-decision");
  const rerank = options.rerank && (options.mode === "auto" || options.mode === "rerank");
  return {
    actions: fastDecision ? "fast-decision" : llm ? "llm" : "source",
    selection: fastDecision ? "fast-decision" : llm ? "llm" : rerank ? "rerank" : "source",
  };
}

/** A work-budget boundary, distinct from retrieval or transport failure. */
export class ExploreBudgetExhausted extends Error {
  constructor() {
    super("Explore search budget exhausted");
  }
}

function stageFromError(error: unknown, signal?: AbortSignal): ExploreModelStageStatus {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  return "failed";
}

/**
 * Shared pure consumer of the existing Explore query protocol. The caller owns
 * start, finish, cancellation and release, and supplies the frozen model binding.
 * Expiry returns participation for completed material; cancellation still throws
 * to that owner. No query scope or source-selection authority lives here.
 */
export async function runExploreModelLoop(options: {
  started: ExploreQueryStartResult;
  complete?: ExploreModelComplete;
  signal?: AbortSignal;
  limit?: number;
  port: ExploreModelLoopPort;
  progress?: {
    phase(phase: ExploreProgressPhase): unknown;
    observe(value: { sources?: ExploreQuerySourceState[]; views?: ExploreQueryView[] }): unknown;
  };
}): Promise<ExploreModelParticipation> {
  const { started, complete, signal, limit, port, progress } = options;
  const participation: ExploreModelParticipation = {
    plan: complete ? "skipped" : "unconfigured",
    select: complete ? "skipped" : "unconfigured",
    followup: complete ? "skipped" : "unconfigured",
  };
  const remaining = () => started.deadlineAt - Date.now();
  const assertActive = () => {
    signal?.throwIfAborted();
    if (remaining() <= 0) throw new ExploreBudgetExhausted();
  };
  const call = <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    return operation();
  };
  const modelSignal = (): AbortSignal => {
    assertActive();
    if (started.deadlineAt === Infinity) return signal ?? new AbortController().signal;
    const timeout = AbortSignal.timeout(remaining());
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  try {
    signal?.throwIfAborted();
    const decisionMode = started.decisionMode ?? "auto";
    const useExploreModel = decisionMode === "auto" || decisionMode === "llm";
    if (!useExploreModel) {
      participation.plan = "disabled";
      participation.select = "disabled";
      participation.followup = "disabled";
    }

    const duties = started.duties;
    if (started.fastDecision && started.fastDecision.status !== "ready") {
      participation.fastDecision = started.fastDecision.status === "invalid" || started.fastDecision.status === "unavailable" ? "failed" : started.fastDecision.status;
    }
    if (!complete && decisionMode === "llm") participation.note = "The selected Explore LLM is unavailable; source ranking was kept.";

    const shouldPlan = useExploreModel && Boolean(complete) && exploreShouldPlanWithModel(started.question, started.parsed.objects);
    if (complete && shouldPlan) {
      progress?.phase("planning");
      try {
        const planText = await complete({
          systemPrompt: EXPLORE_PLAN_SYSTEM,
          user: renderExplorePlanPrompt(started),
          signal: modelSignal(),
        });
        const plan = parseExplorePlan(planText);
        if (plan) {
          const submitted = await call(() => port.plan(plan));
          progress?.observe(submitted);
          participation.plan = submitted.launched.length > 0 ? "used" : "skipped";
        } else {
          participation.plan = "failed";
          participation.note = "Explore model plan was unused; excerpts are from algorithm and vector sources.";
        }
      } catch (error) {
        signal?.throwIfAborted();
        participation.plan = stageFromError(error, signal);
        if (participation.plan === "failed") {
          participation.note = "Explore model plan failed; excerpts are from algorithm and vector sources.";
        }
      }
    }

    const seen = new Set<string>();
    const offeredActions = new Map<string, string>();
    const selectedViews = new Map<string, ExploreQueryView>();
    const useSelection = complete && useExploreModel && duties?.selection !== "fast-decision"
      && duties?.selection !== "rerank" && duties?.selection !== "source"
      && exploreShouldSelectWithModel(started.question, started.parsed.objects, participation.plan === 'used');
    while (remaining() > 0) {
      signal?.throwIfAborted();
      progress?.phase("collecting");
      const retained = port.retained?.() ?? [...selectedViews.values()];
      selectedViews.clear();
      for (const view of retained) selectedViews.set(view.viewId, view);
      const actionContext = retained.map(view => view.viewId).sort().join('|');
      const views = await call(() => port.views({ seen: [...seen] }));
      progress?.observe(views);
      const freshActions = views.actions.filter(action => offeredActions.get(action.actionId) !== actionContext);
      if (useSelection && (views.views.length > 0 || freshActions.length > 0)) {
        progress?.phase("selecting");
        try {
          const request = (batch: ExploreQueryView[]) => ({
            systemPrompt: EXPLORE_SELECT_SYSTEM,
            user: renderExploreSelectPrompt(started.question, { ...views, actions: freshActions }, "incremental", {
              selectedViews: batch.filter(view => selectedViews.has(view.viewId)),
              retainedCatalog: retained,
              newViews: batch.filter(view => !selectedViews.has(view.viewId)),
              ...(limit === undefined ? {} : { excerptLimit: limit }),
            }),
            materials: batch,
          });
          const partition = await partitionExploreViews(views.views.length ? views.views : retained, retained,
            batch => complete!.fitsInput?.(request(batch)) ?? Promise.resolve(true));
          const batch = partition.batches[0] ?? [];
          for (const view of partition.oversized) seen.add(view.viewId);
          if (partition.oversized.length) participation.note = `Complete source views exceed the selected model input capacity: ${partition.oversized.map(view => `${view.path}:${view.startLine}-${view.endLine}`).join(', ')}.`;
          if (complete!.fitsInput && !await complete!.fitsInput(request(batch))) throw new Error('Selection context exceeds model input capacity');
          const selected = parseExploreSelection(await complete!({
            ...request(batch), signal: modelSignal(),
          }));
          for (const view of batch) seen.add(view.viewId);
          for (const action of freshActions) offeredActions.set(action.actionId, actionContext);
          if (!selected) throw new Error("Explore model returned no valid selection or follow-up.");
          // A follow-up without a new selection keeps the last accepted material.
          // A completed empty decision still explicitly clears it.
          const continuing = !selected.done && Boolean(selected.followup || selected.actionIds.length);
          if (selected.groups.length || !continuing) {
            const applied = await call(() => port.select(selected.groups));
            selectedViews.clear();
            for (const view of applied.selectedViews) selectedViews.set(view.viewId, view);
            participation.select = applied.accepted.length || !selected.groups.length || selectedViews.size ? "used" : "skipped";
            if (!applied.accepted.length && applied.rejected.length) {
              participation.note = `Explore model selection was rejected: ${[...new Set(applied.rejected.map(entry => entry.reason))].join('; ')}. Source ranking was kept.`;
            }
          }
          const actions = views.actions.filter(action => selected.actionIds.includes(action.actionId));
          let launched = false;
          if (selected.followup || actions.length) {
            progress?.phase("following-up");
            const result = await call(() => port.followup({ ...selected.followup, actions }));
            progress?.observe(result);
            launched = result.launched.length > 0;
            participation.followup = launched ? "used" : "skipped";
          }
          if (selected.done && !launched) {
            const arrived = await call(() => port.views({ seen: [...seen] }));
            if (arrived.views.some(view => !views.views.some(previous => previous.viewId === view.viewId))) continue;
            port.deliver?.(); break;
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof ExploreEvidenceChanged) continue;
          if (participation.select === 'used') {
            participation.followup = stageFromError(error, signal);
            participation.note = 'Explore follow-up failed; the earlier accepted material was kept.';
          } else {
            participation.select = stageFromError(error, signal);
            participation.note = "Explore model selection failed; acquired source material was kept.";
          }
          break;
        }
      } else {
        for (const view of views.views) seen.add(view.viewId);
      }
      if (views.unevaluated > 0) continue;
      // Re-collect after inference/submission: a producer may have progressed
      // during that await. The sequence makes check-and-wait race-free.
      const next = await call(() => port.views({ seen: [...seen] }));
      progress?.observe(next);
      if (next.views.some(view => !seen.has(view.viewId)) || next.sequence !== views.sequence) continue;
      if (!next.pending) break;
      await call(() => port.wait(next.sequence));
    }
    signal?.throwIfAborted();
    return participation;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ExploreBudgetExhausted) return participation;
    throw error;
  }
}
