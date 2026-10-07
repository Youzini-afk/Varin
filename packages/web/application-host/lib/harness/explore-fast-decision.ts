/**
 * Fast Decision loop for explore queries (D-312). The query owner keeps file,
 * graph, revision, and cancellation authority; this module only turns real
 * views and issued action candidates into typed questions, applies the
 * provider's judgments through `applySelection`/`followup`, and reports what
 * actually happened.
 *
 * Two axes stay separate on purpose: `m:` questions decide whether material
 * belongs in the returned answer, `a:` questions decide whether a concrete
 * next step is worth executing. A missing answer is never read as a no.
 */
import {
  fastDecisionCapabilities,
  type ExploreFastDecisionDetails,
  type ExploreModelStageStatus,
  type ExploreQueryAction,
  type ExploreQueryView,
  type FastDecisionAnswer,
  type FastDecisionMaterial,
  type FastDecisionQuestion,
  type HarnessFastDecisionPurposeStatus,
  type HarnessResolvedFastDecisionBinding,
} from "@varin/protocol";
import type { ExploreQueryRun } from "./explore.js";

/** What `explore.query.start` freezes onto the query and reports to callers. */
export type ExploreFastDecisionState =
  | { status: "ready"; binding: HarnessResolvedFastDecisionBinding }
  | { status: "disabled" | "unconfigured" | "invalid" | "unavailable"; message?: string };

/**
 * Map the Pi-described purpose status onto the state a query freezes at
 * start. A missing entry means the runtime predates the capability.
 */
export function resolveExploreFastDecision(
  status: HarnessFastDecisionPurposeStatus | undefined,
): ExploreFastDecisionState {
  if (!status) return { status: "unavailable" };
  if (status.status === "ready") return { status: "ready", binding: status.binding };
  return { status: status.status, ...("message" in status && status.message ? { message: status.message } : {}) };
}

export function fastDecisionStageStatus(details: ExploreFastDecisionDetails | undefined): ExploreModelStageStatus {
  return details?.status ?? "skipped";
}

const MATERIAL_YES = "Carries evidence the answer should cite: the implementation, call path, contract, or failure the question is about.";
const MATERIAL_NO = "Does not carry that evidence — an unrelated match, a duplicated window, or noise.";
const ACTION_YES = "Executing this step is likely to produce material that improves the answer.";
const ACTION_NO = "This step is unlikely to add evidence beyond what is already read or selected.";

const isAbort = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export interface ExploreFastDecisionLoopInput {
  run: ExploreQueryRun;
  judgeMaterials?: boolean;
  /** Binding resolved when the query started; settings edits never reach it. */
  binding: HarnessResolvedFastDecisionBinding;
  /** One batch against the provider; throws on provider/transport failure. */
  call: (input: {
    goal: string;
    materials: FastDecisionMaterial[];
    questions: FastDecisionQuestion[];
    signal: AbortSignal;
  }) => Promise<HarnessFastDecisionResultWire>;
  /** Loop lifetime: cancel/release/finish-stop. Outlives the source deadline. */
  signal: AbortSignal;
  /** Public explore may submit a generated plan after the first quiet round. */
  waitForLaterProgress?: boolean;
  /** Wall clock the loop must not outrun. */
  deadlineAt: number;
  /**
   * Set by `explore.query.finish`: stop offering new actions, judge what is
   * already fresh once, and settle. `promise` wakes a parked round.
   */
  closing: { promise: Promise<void>; requested: () => boolean };
  now?: () => number;
}

export interface HarnessFastDecisionResultWire {
  answers: FastDecisionAnswer[];
  missing: string[];
  servedModelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Progressive selection: judge fresh material for the answer, judge pending
 * actions for exploration value, execute chosen actions inside the same
 * query, and repeat while new material keeps arriving. Terminates on a
 * quiet round, a cancelled/finished query, the deadline, or a settle
 * request — never on a fixed round count.
 *
 * Provider and transport failures do not throw out of here: the loop returns
 * honest details so the query can finish on source-ranked material.
 */
export async function runExploreFastDecisionLoop(
  input: ExploreFastDecisionLoopInput,
): Promise<ExploreFastDecisionDetails> {
  const now = input.now ?? Date.now;
  const waitForLaterProgress = input.waitForLaterProgress === true;
  const details: ExploreFastDecisionDetails = {
    status: "used",
    providerId: input.binding.providerId,
    modelId: input.binding.modelId,
    batches: 0,
    rounds: 0,
    viewsJudged: 0,
    actionsOffered: 0,
    actionsExecuted: 0,
    executed: [],
    missing: 0,
    unevaluatedMaterials: 0,
  };
  const acceptedActions = new Set<string>();
  const judged = new Set<string>();
  const judgedActions = new Set<string>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;

  try {
    while (input.run.terminal() === "active") {
      input.signal.throwIfAborted();
      if (now() >= input.deadlineAt) break;
      const capacity = fastDecisionCapabilities(input.binding.protocol).maxStateTokens;
      const retained = input.run.selectedViews();
      const snapshot = input.run.collect({ seen: [...judged],
        ...(capacity ? { inputBytes: Math.max(1, capacity - Buffer.byteLength(JSON.stringify(retained) + input.run.question)) } : {}) });
      const closing = input.closing.requested();
      const canAct = !closing && !input.run.signal.aborted;
      const { views, unevaluated } = snapshot;
      const fresh = views.filter(view => !view.unevaluated);
      if (!closing && !judged.size && !fresh.length && snapshot.pending) {
        await Promise.race([input.run.waitForProgress(snapshot.sequence, input.signal), input.closing.promise]);
        continue;
      }
      const contextKey = retained.map(view => view.viewId).sort().join('|');
      // Action discovery is asynchronous. Keep the public collector waiting
      // while this round discovers/judges candidates, even if sources settled.
      input.run.setJudgmentPending(true);
      const pending = canAct ? (await input.run.actionCandidates()).filter(candidate =>
        !details.executed.includes(candidate.actionId) && !judgedActions.has(`${candidate.actionId}@${contextKey}`)) : [];
      if (fresh.length === 0 && pending.length === 0) {
        input.run.setJudgmentPending(false);
        const idle = input.run.collect({ seen: [...judged] });
        if (!idle.pending && !waitForLaterProgress || input.run.signal.aborted || closing) break;
        await Promise.race([input.run.waitForProgress(idle.sequence, input.signal), input.closing.promise]);
        continue;
      }
      details.rounds += 1;
      // `unevaluated` is the current snapshot count, not a per-round delta.
      // Keep it truthful when the loop wakes for later plans or follow-ups.
      details.unevaluatedMaterials = unevaluated;

      const materials: FastDecisionMaterial[] = [...retained, ...fresh.filter(view => !retained.some(item => item.viewId === view.viewId))].map((view: ExploreQueryView) => ({
        id: view.viewId,
        label: `${view.path}:${view.startLine}-${view.endLine}`,
        revision: view.revision,
        text: view.text,
      }));
      const questions: FastDecisionQuestion[] = [
        ...(input.judgeMaterials === false ? [] : fresh).map((view): FastDecisionQuestion => ({
          id: `m:${view.viewId}`,
          kind: "judge",
          instructions: {
            question: "Should the material with this id be part of the answer to the goal?",
            material: view.viewId,
            location: `${view.path}:${view.startLine}-${view.endLine}`,
          },
          criteria: { yes: MATERIAL_YES, no: MATERIAL_NO },
        })),
        ...pending.map((action: ExploreQueryAction): FastDecisionQuestion => ({
          id: `a:${action.actionId}`,
          kind: "judge",
          instructions: {
            question: "Would executing this step likely produce material that improves the answer?",
            step: { id: action.actionId, kind: action.kind, target: action.target, reason: action.why },
          },
          criteria: { yes: ACTION_YES, no: ACTION_NO },
        })),
      ];

      for (const view of fresh) judged.add(view.viewId);
      if (!questions.length) {
        input.run.setJudgmentPending(false);
        if (closing) break;
        continue;
      }
      const result = await input.call({
        goal: input.run.question,
        materials,
        questions,
        signal: input.signal,
      });
      details.batches += 1;
      if (input.judgeMaterials !== false) details.viewsJudged += fresh.length;
      details.actionsOffered += pending.length;
      details.missing += result.missing.length;
      if (result.servedModelId) details.servedModelId = result.servedModelId;
      if (result.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        };
      }
      for (const view of fresh) judged.add(view.viewId);
      for (const action of pending) judgedActions.add(`${action.actionId}@${contextKey}`);
      const answered = new Map(result.answers.map((answer) => [answer.id, answer]));

      const include = fresh
        .filter((view) => {
          const answer = answered.get(`m:${view.viewId}`);
          return answer?.kind === "judge" && answer.value >= 0.5;
        })
        .map((view) => view.viewId);
      if (include.length > 0) {
        input.run.applySelection([{
          id: `fast:${details.rounds}`,
          purpose: "fast-decision material",
          views: include.map((viewId) => ({ viewId, required: false })),
        }], { merge: true });
      }

      if (input.closing.requested()) break;
      const chosen = pending.filter((action) => {
        const answer = answered.get(`a:${action.actionId}`);
        return answer?.kind === "judge" && answer.value >= 0.5;
      });
      if (chosen.length === 0) continue;
      const followup = await input.run.followup({ actions: chosen });
      for (const id of followup.actionsAccepted) acceptedActions.add(id);

      // A quiet action round can still be followed by a later generated plan;
      // wait for progress or the query close/deadline instead of ending early.

    }
  } catch (error) {
    const aborted = isAbort(error) || input.signal.aborted || input.run.terminal() === "cancelled";
    details.status = aborted ? "cancelled" : "failed";
    if (!aborted) details.note = errorMessage(error);
  } finally { input.run.setJudgmentPending(false); }
  details.executed = input.run.completedActionIds().filter(id => acceptedActions.has(id));
  details.actionsExecuted = details.executed.length;
  if (usage) details.usage = usage;
  if (details.batches === 0 && details.status === "used") {
    details.status = 'skipped';
    details.note = "No evaluable material arrived before the loop settled.";
  }
  return details;
}
