import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentInputContext, ExploreModelParticipation, ExploreModelStageStatus } from "@varin/protocol";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";
import { createExploreProgress } from "./explore-progress.js";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";
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

const ExploreParams = Type.Object({
  question: Type.String({ description: "What you want to find or understand in the codebase" }),
  anchors: Type.Optional(Type.Array(Type.String(), {
    description: "Known symbols, method names, error text, or path fragments. Matched literally and prioritized; not a hard filter.",
  })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Search only these files/directories. Accepts absolute paths or paths relative to the session cwd, including ../ and multiple projects. Omit to search the session cwd." })),
  budgetMs: Type.Optional(Type.Integer({ minimum: 1, maximum: HARNESS_MAX_REQUEST_TIMEOUT_MS, description: "Time budget for search and model work in milliseconds (default 120000). Increase for deeper searches; completed material is returned when the budget expires." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of excerpts to return (default 20)" })),
});

/** Public remaining wait shared across stages. Not a calibrated SLO. */
export const EXPLORE_PUBLIC_BUDGET_MS = 120_000;

class ExploreBudgetExhausted extends Error {
  constructor() {
    super("Explore search budget exhausted");
  }
}

function boundByDeadline(signal: AbortSignal | undefined, deadlineAt: number): AbortSignal {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new ExploreBudgetExhausted();
  const timeout = AbortSignal.timeout(remaining);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type ExploreModelComplete = ((input: {
  systemPrompt: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>) & { inputBytes?: number };

function stageFromError(error: unknown, signal?: AbortSignal): ExploreModelStageStatus {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  return "failed";
}

export function createExploreTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  options?: { complete?: ExploreModelComplete },
): ToolDefinition {
  return defineTool({
    name: "explore",
    label: "Explore",
    description: "Locate relevant code and read the related context in the same call (definitions, registration sites, callers, and the excerpts needed to judge). Optional anchors prioritize literal symbols, method names, error text, and path fragments. Natural-language questions can be rewritten into repository search expressions when models.explore is configured; conceptual names do not have to match identifiers literally.",
    promptSnippet: "explore: locate and read related source context with optional literal anchors and model-assisted query mapping",
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, onUpdate, _ctx) => {
      const progress = createExploreProgress(value => onUpdate?.({ content: [], details: { progress: value } }));
      progress.phase("starting");
      const pinned: AgentInputContext = structuredClone(bridge.inputContext() ?? { source: "disk" });
      const budgetMs = params.budgetMs ?? EXPLORE_PUBLIC_BUDGET_MS;
      let deadlineAt = Date.now() + budgetMs;
      const remaining = (): number => Math.max(0, deadlineAt - Date.now());
      const participation: ExploreModelParticipation = {
        plan: options?.complete ? "skipped" : "unconfigured",
        select: options?.complete ? "skipped" : "unconfigured",
        followup: options?.complete ? "skipped" : "unconfigured",
      };
      let queryId = "";
      const request = async <M extends "explore.query.start" | "explore.query.plan" | "explore.query.views" | "explore.query.wait" | "explore.query.select" | "explore.query.followup" | "explore.query.finish" | "explore.query.release" | "explore.query.cancel">(
        method: M,
        methodParams: Parameters<HostServicesBridge["request"]>[1],
      ) => {
        // Search owns its work deadline; transport needs time to deliver the
        // partial result after sources stop. Never cancel that result at 1ms.
        const collecting = method === "explore.query.finish" || method === "explore.query.release" || method === "explore.query.cancel";
        if (!collecting && remaining() <= 0) throw new ExploreBudgetExhausted();
        return bridge.request(method, methodParams as never, {
          ...(signal ? { signal } : {}),
          timeoutMs: collecting ? 30_000 : Math.min(HARNESS_MAX_REQUEST_TIMEOUT_MS, remaining() + 30_000),
          inputContext: pinned,
        });
      };

      const finish = async () => {
        progress.phase("finishing");
        const exhausted = remaining() <= 0;
        if (exhausted) participation.note = [participation.note, `Explore search budget exhausted (${budgetMs}ms); returning completed material. Increase budgetMs or narrow paths to continue.`].filter(Boolean).join(" ");
        const result = await request("explore.query.finish", { queryId, model: participation });
        signal?.throwIfAborted();
        const partial = result.partial || exhausted;
        const completed = progress.phase(partial ? "partial" : result.snippets.length ? "complete" : "empty");
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            snippets: result.snippets, searched: result.searched, handle: result.handle,
            snippetCount: result.snippets.length, issueCount: result.issueCount,
            partial, notRequestedCount: result.notRequestedCount,
            omittedCount: result.omittedCount, provenance: result.details,
            provenanceCounts: result.details.provenance.statusCounts,
            model: result.details.model ?? participation,
            budgetMs, budgetExhausted: exhausted,
            progress: completed,
          },
        };
      };

      const cancelQuery = (): void => {
        if (!queryId) return;
        try {
          bridge.cancel({ queryId });
        } catch {
          // Cancel is best-effort; the public tool is already stopping.
        }
      };
      if (signal) {
        if (signal.aborted) cancelQuery();
        else signal.addEventListener("abort", cancelQuery, { once: true });
      }

      try {
        signal?.throwIfAborted();
        const complete = options?.complete;
        const started = await request("explore.query.start", {
          question: params.question,
          ...(params.anchors ? { anchors: params.anchors } : {}),
          ...(params.paths ? { paths: params.paths } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
          budgetMs: remaining(),
          reserveForJudge: Boolean(complete),
        });
        queryId = started.queryId;
        progress.observe(started);
        deadlineAt = Math.min(deadlineAt, started.deadlineAt);
        const modelSignal = () => boundByDeadline(signal, deadlineAt);
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
        if (!complete && useExploreModel) participation.note = "Explore model is not configured; available retrieval sources are used.";

        const shouldPlan = useExploreModel && Boolean(complete) && exploreShouldPlanWithModel(params.question, started.parsed.objects);
        if (complete && shouldPlan) {
          progress.phase("planning");
          try {
            const planText = await complete({
              systemPrompt: EXPLORE_PLAN_SYSTEM,
              user: renderExplorePlanPrompt(started),
              signal: modelSignal(),
            });
            const plan = parseExplorePlan(planText);
            if (plan) {
              const submitted = await request("explore.query.plan", { queryId, plan });
              progress.observe(submitted);
              participation.plan = submitted.launched.length > 0 ? "used" : "skipped";
            } else {
              participation.plan = "failed";
              participation.note = "Explore model plan was unused; excerpts are from algorithm and vector sources.";
            }
          } catch (error) {
            participation.plan = stageFromError(error, signal);
            if (participation.plan === "failed") {
              participation.note = "Explore model plan failed; excerpts are from algorithm and vector sources.";
            }
          }
        }

        const seen = new Set<string>();
        const offeredActions = new Map<string, string>();
        const selectedViews = new Map<string, import("@varin/protocol").ExploreQueryView>();
        const useSelection = complete && useExploreModel && duties?.selection !== "fast-decision"
          && duties?.selection !== "rerank" && duties?.selection !== "source"
          && exploreShouldSelectWithModel(params.question, started.parsed.objects, participation.plan === 'used');
        let modelFailed = false;
        while (remaining() > 0) {
          signal?.throwIfAborted();
          progress.phase("collecting");
          const retained = [...selectedViews.values()];
          const actionContext = retained.map(view => view.viewId).sort().join('|');
          const capacity = complete?.inputBytes;
          const retainedBytes = new TextEncoder().encode(JSON.stringify(retained) + EXPLORE_SELECT_SYSTEM + params.question).length;
          const views = await request("explore.query.views", { queryId, seen: [...seen],
            ...(capacity ? { inputBytes: Math.max(1, capacity - retainedBytes) } : {}) });
          progress.observe(views);
          const freshActions = views.actions.filter(action => offeredActions.get(action.actionId) !== actionContext);
          if (useSelection && !modelFailed && (views.views.length > 0 || freshActions.length > 0)) {
            progress.phase("selecting");
            try {
              const selected = parseExploreSelection(await complete!({
                systemPrompt: EXPLORE_SELECT_SYSTEM,
                user: renderExploreSelectPrompt(params.question, { ...views, actions: freshActions }, "incremental", {
                  selectedViews: retained, newViews: views.views, excerptLimit: params.limit ?? 20,
                }), signal: modelSignal(),
              }));
              for (const view of views.views) seen.add(view.viewId);
              for (const action of freshActions) offeredActions.set(action.actionId, actionContext);
              if (!selected) throw new Error("Explore model returned no valid selection or follow-up.");
              // Each batch compares its new evidence with the retained group.
              // Replacement is explicit, rather than accumulating every yes.
              const applied = await request("explore.query.select", { queryId, groups: selected.groups });
              selectedViews.clear();
              for (const view of applied.selectedViews) selectedViews.set(view.viewId, view);
              participation.select = applied.accepted.length || !selected.groups.length || selectedViews.size ? "used" : "skipped";
              if (!applied.accepted.length && applied.rejected.length) {
                participation.note = `Explore model selection was rejected: ${[...new Set(applied.rejected.map(entry => entry.reason))].join('; ')}. Source ranking was kept.`;
              }
              const actions = views.actions.filter(action => selected.actionIds.includes(action.actionId));
              let launched = false;
              if (selected.followup || actions.length) {
                progress.phase("following-up");
                const result = await request("explore.query.followup", { queryId, ...selected.followup, actions });
                progress.observe(result);
                launched = result.launched.length > 0;
                participation.followup = launched ? "used" : "skipped";
              }
              if (selected.done && !launched) break;
            } catch (error) {
              if (participation.select === 'used') {
                participation.followup = stageFromError(error, signal);
                participation.note = 'Explore follow-up failed; the earlier accepted material was kept.';
              } else {
                participation.select = stageFromError(error, signal);
                participation.note = "Explore model selection failed; acquired source material was kept.";
              }
              modelFailed = true;
            }
          } else {
            for (const view of views.views) seen.add(view.viewId);
          }
          if (views.unevaluated > 0) continue;
          // Re-collect after inference/submission: a producer may have progressed
          // during that await. The sequence makes check-and-wait race-free.
          const next = await request("explore.query.views", { queryId, seen: [...seen] });
          progress.observe(next);
          if (next.views.some(view => !seen.has(view.viewId)) || next.sequence !== views.sequence) continue;
          if (!next.pending) break;
          await request("explore.query.wait", { queryId, afterSequence: next.sequence });
        }

        return await finish();
      } catch (caught) {
        let error: unknown = caught;
        if (!signal?.aborted && queryId && error instanceof ExploreBudgetExhausted) {
          try { return await finish(); }
          catch (finishError) { error = finishError; }
        }
        // Keep the cancellation receipt in the native error result. The run's
        // aborted signal still ends the Agent loop; no finish or new work runs.
        const cancelled = signal?.aborted === true;
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = error instanceof HarnessRequestError ? error.code : undefined;
        return {
          content: [{ type: "text", text: cancelled ? "explore cancelled" : `explore failed: ${message}` }],
          details: { error: message, ...(errorCode ? { errorCode } : {}),
            progress: progress.phase(cancelled ? "cancelled" : errorCode === "unavailable" ? "unavailable" : "failed") },
          isError: true,
        };
      } finally {
        signal?.removeEventListener("abort", cancelQuery);
        if (queryId) {
          try {
            await bridge.request("explore.query.release", { queryId }, {
              timeoutMs: 5_000,
              inputContext: pinned,
            });
          } catch {
            // Release is cleanup; the tool result is already decided.
          }
        }
      }
    },
  });
}
