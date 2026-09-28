import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentInputContext, ExploreModelParticipation, ExploreModelStageStatus } from "@varin/protocol";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";
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

export type ExploreModelComplete = (input: {
  systemPrompt: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

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
    description: "Locate relevant code and read the related context in the same call (definitions, registration sites, callers, and the excerpts needed to judge). Use grep when you only need an exact match. Put known symbols, method names, error text, and path fragments in anchors. Natural-language questions can be rewritten into repository search expressions when models.explore is configured; conceptual names do not have to match identifiers literally.",
    promptSnippet: "explore: locate and read related context in one call; put known symbols, method names, error text, and path fragments in anchors; conceptual questions can be mapped to repository names; use grep for exact match only",
    promptGuidelines: [
      "Use explore to locate code and read the related context (definitions, registration sites, callers, and excerpts needed to judge) in one call.",
      "Use grep when you only need exact matches.",
      "Put known symbols, method names, error text, and path fragments in anchors.",
      "Use paths to choose one or more search directories, especially when cwd contains multiple projects. Absolute and cwd-relative paths are supported; anchors do not widen explicit paths.",
      "Set budgetMs to adjust search time and limit to adjust the number of returned excerpts. Inspect reported scope and incomplete coverage before widening a search.",
      "Explore can bridge a conceptual question and repository identifiers when an explore model is configured. It still returns current source excerpts, not a substitute analysis.",
    ],
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
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
      const request = async <M extends "explore.query.start" | "explore.query.plan" | "explore.query.views" | "explore.query.select" | "explore.query.followup" | "explore.query.finish" | "explore.query.release" | "explore.query.cancel">(
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
        const exhausted = remaining() <= 0;
        if (exhausted) participation.note = [participation.note, `Explore search budget exhausted (${budgetMs}ms); returning completed material. Increase budgetMs or narrow paths to continue.`].filter(Boolean).join(" ");
        const result = await request("explore.query.finish", { queryId, model: participation });
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            snippets: result.snippets, searched: result.searched, handle: result.handle,
            snippetCount: result.snippets.length, issueCount: result.issueCount,
            partial: result.partial || exhausted, notRequestedCount: result.notRequestedCount,
            omittedCount: result.omittedCount, provenance: result.details,
            provenanceCounts: result.details.provenance.statusCounts,
            model: result.details.model ?? participation,
            budgetMs, budgetExhausted: exhausted,
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
        deadlineAt = Math.min(deadlineAt, started.deadlineAt);
        const modelSignal = () => boundByDeadline(signal, deadlineAt);
        const decisionMode = started.decisionMode ?? "auto";
        const useExploreModel = decisionMode === "auto" || decisionMode === "llm";
        if (!useExploreModel) {
          participation.plan = "disabled";
          participation.select = "disabled";
          participation.followup = "disabled";
        }

        // D-312: a ready fast-decision binding owns material relevance and
        // action choice inside the query; the generative model keeps only its
        // plan stage — the same judgment is not stacked twice (design §4.4).
        const fastDecisionActive = started.fastDecision?.status === "ready";
        if (started.fastDecision && started.fastDecision.status !== "ready") {
          participation.fastDecision = started.fastDecision.status === "invalid" || started.fastDecision.status === "unavailable" ? "failed" : started.fastDecision.status;
        }
        if (!complete && useExploreModel) {
          participation.note = "Explore model is not configured; excerpts are from algorithm and vector sources.";
        }

        const shouldPlan = useExploreModel && Boolean(complete) && exploreShouldPlanWithModel(params.question, started.parsed.objects);
        if (complete && shouldPlan) {
          try {
            const planText = await complete({
              systemPrompt: EXPLORE_PLAN_SYSTEM,
              user: renderExplorePlanPrompt(started),
              signal: modelSignal(),
            });
            const plan = parseExplorePlan(planText);
            if (plan) {
              const submitted = await request("explore.query.plan", { queryId, plan });
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

        const views = await request("explore.query.views", { queryId });
        const shouldSelect = useExploreModel && Boolean(complete)
          && !fastDecisionActive
          && views.views.length > 0
          && exploreShouldSelectWithModel(params.question, started.parsed.objects, participation.plan === "used");
        if (complete && shouldSelect) {
          let activeStage: "select" | "followup" = "select";
          try {
            const selectText = await complete({
              systemPrompt: EXPLORE_SELECT_SYSTEM,
              user: renderExploreSelectPrompt(params.question, views, "full", { excerptLimit: params.limit ?? 20 }),
              signal: modelSignal(),
            });
            const selected = parseExploreSelection(selectText);
            if (selected) {
              const applied = await request("explore.query.select", { queryId, groups: selected.groups });
              participation.select = applied.accepted.length > 0 ? "used" : "skipped";
              if (participation.select === "used" && (participation.plan === "failed" || participation.plan === "cancelled")) {
                participation.note = `Explore model plan ${participation.plan}; model selection used the candidates that were available.`;
              }
              if (applied.accepted.length === 0 && applied.rejected.length > 0) {
                participation.note = `Explore model selection was rejected: ${[...new Set(applied.rejected.map((entry) => entry.reason))].join("; ")}. Source ranking was kept.`;
              }
              if (selected.followup && Date.now() < deadlineAt) {
                activeStage = "followup";
                const followup = await request("explore.query.followup", {
                  queryId,
                  ...(selected.followup.searches ? { searches: selected.followup.searches } : {}),
                  ...(selected.followup.locates ? { locates: selected.followup.locates } : {}),
                  ...(selected.groups.map((group) => group.gap).filter(Boolean).length
                    ? { gaps: selected.groups.flatMap((group) => group.gap ? [group.gap] : []) }
                    : {}),
                });
                participation.followup = followup.launched.length > 0 ? "used" : "skipped";
                if (followup.newViews.length > 0) {
                  const acceptedViewIds = new Set(applied.accepted.flatMap((group) => group.viewIds));
                  const selectedViews = views.views.filter((view) => (
                    acceptedViewIds.has(view.viewId)
                  ));
                  const incrementalText = await complete({
                    systemPrompt: EXPLORE_SELECT_SYSTEM,
                    user: renderExploreSelectPrompt(params.question, views, "incremental", {
                      selectedViews,
                      newViews: followup.newViews,
                      excerptLimit: params.limit ?? 20,
                    }),
                    signal: modelSignal(),
                  });
                  const incremental = parseExploreSelection(incrementalText);
                  if (incremental) {
                    const incrementallyApplied = await request("explore.query.select", { queryId, groups: incremental.groups, merge: true });
                    if (incrementallyApplied.accepted.length > 0) {
                      participation.select = "used";
                      if (participation.plan === "failed" || participation.plan === "cancelled") {
                        participation.note = `Explore model plan ${participation.plan}; model selection used the candidates that were available.`;
                      }
                    } else if (incrementallyApplied.rejected.length > 0) {
                      participation.note = `Explore follow-up selection was rejected: ${[...new Set(incrementallyApplied.rejected.map((entry) => entry.reason))].join("; ")}. Earlier material was kept.`;
                    }
                  }
                }
              }
            } else {
              participation.select = "failed";
              participation.note = participation.note
                ?? "Explore model selection was unused; excerpts are from algorithm and vector sources.";
            }
          } catch (error) {
            const status = stageFromError(error, signal);
            if (activeStage === "select") {
              participation.select = status;
              if (status === "failed") {
                participation.note = participation.note
                  ?? "Explore model selection failed; excerpts are from algorithm and vector sources.";
              }
            } else {
              participation.followup = status;
              if (status === "failed") {
                participation.note = participation.note
                  ?? (participation.select === "used"
                    ? "Explore follow-up failed; the earlier accepted material was kept."
                    : "Explore follow-up failed; excerpts are from algorithm and vector sources.");
              }
            }
          }
        }

        return await finish();
      } catch (caught) {
        let error: unknown = caught;
        signal?.throwIfAborted();
        if (queryId && error instanceof ExploreBudgetExhausted) {
          try { return await finish(); }
          catch (finishError) { signal?.throwIfAborted(); error = finishError; }
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `explore failed: ${message}` }],
          details: { error: message },
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
