import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentInputContext, ExploreModelComplete, ExploreModelParticipation } from "@varin/protocol";
import { ExploreBudgetExhausted, HARNESS_MAX_REQUEST_TIMEOUT_MS, runExploreModelLoop } from "@varin/protocol";
import { createExploreProgress } from "./explore-progress.js";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";

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

export function createExploreTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  options?: { complete?: ExploreModelComplete },
): ToolDefinition {
  return defineTool({
    name: "explore",
    label: "Explore",
    description: "Find code relevant to a question and return source excerpts with file paths and line numbers. Optional anchors prioritize known symbols, error text, and path fragments.",
    promptSnippet: "explore: find and read related code",
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, onUpdate, _ctx) => {
      const progress = createExploreProgress(value => onUpdate?.({ content: [], details: { progress: value } }));
      progress.phase("starting");
      const pinned: AgentInputContext = structuredClone(bridge.inputContext() ?? { source: "disk" });
      const budgetMs = params.budgetMs ?? EXPLORE_PUBLIC_BUDGET_MS;
      let deadlineAt = Date.now() + budgetMs;
      const remaining = (): number => Math.max(0, deadlineAt - Date.now());
      let participation: ExploreModelParticipation = {
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
            omittedCount: result.omittedCount,
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
        participation = await runExploreModelLoop({
          started: { ...started, deadlineAt },
          ...(complete ? { complete } : {}),
          ...(signal ? { signal } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          progress,
          port: {
            plan: plan => request("explore.query.plan", { queryId, plan }),
            views: options => request("explore.query.views", { queryId, ...options }),
            wait: afterSequence => request("explore.query.wait", { queryId, afterSequence }),
            select: groups => request("explore.query.select", { queryId, groups }),
            followup: options => request("explore.query.followup", { queryId, ...options }),
          },
        });

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
