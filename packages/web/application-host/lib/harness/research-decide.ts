/**
 * D-315 / Stage L5: `research.decide` — batch fast-decision judgment over
 * real Web and scholarly candidates.
 *
 * Candidates come from material the caller already produced: URLs from
 * `web.search`, pinned snapshots from `web.fetch`, scholarly identities from
 * `research.search`, snapshot sections, or new query expressions. The Host
 * rejects references it cannot resolve under the caller's own authority
 * (unreadable snapshots, malformed papers), so the model only judges real
 * options and never invents ids.
 *
 * Binding follows the D-312 machinery: the caller's `purpose` slot resolves
 * through `fastDecisionStatus`, the ready binding freezes `configurationId`
 * for this call, and `fastDecision` executes the batch. When the purpose is
 * disabled, unconfigured, unavailable, or the call fails or is cancelled,
 * the result reports that status honestly and keeps the caller-supplied
 * order in `ranked` — direct search and the agent's own judgment continue.
 * Missing answers are listed, never scored as zero; no score is read as a
 * research-completeness proof.
 */
import type {
  FastDecisionMaterial,
  FastDecisionQuestion,
  FetchResult,
  HarnessFastDecisionPurpose,
  HarnessFastDecisionPurposeStatus,
  HarnessFastDecisionResult,
  HarnessResolvedFastDecisionBinding,
  ResearchDecideKind,
  ResearchDecideParams,
  ResearchDecideRankedCandidate,
  ResearchDecideResult,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";
import type { WebSnapshotReadAuthority } from "./web-materials.js";

/** Per-candidate excerpt budget so sections stay inside the state budget. */
const MATERIAL_EXCERPT_LIMIT = 2000;

/** Trusted runtime adapters retain ownership of material reads and inference. */
export interface ResearchDecideContext {
  signal: AbortSignal;
  authority: WebSnapshotReadAuthority;
  readCandidateText(
    request: { snapshotId: string; startLine?: number; endLine?: number },
    authority: WebSnapshotReadAuthority,
    signal: AbortSignal,
  ): Promise<FetchResult>;
  fastDecisionStatus(purpose: HarnessFastDecisionPurpose): Promise<HarnessFastDecisionPurposeStatus>;
  fastDecision(input: {
    purpose: HarnessFastDecisionPurpose;
    settings: HarnessResolvedFastDecisionBinding;
    goal: string;
    materials: FastDecisionMaterial[];
    questions: FastDecisionQuestion[];
    signal: AbortSignal;
  }): Promise<HarnessFastDecisionResult>;
}

/** Only the trusted inference adapter may attach an accounted result to failure. */
export class ResearchDecisionFailure extends Error {
  constructor(message: string, readonly result?: HarnessFastDecisionResult, readonly cancelled = false) {
    super(message);
    this.name = "ResearchDecisionFailure";
  }
}

const KIND_INSTRUCTIONS: Record<Exclude<ResearchDecideKind, "next">, string> = {
  "relevance": "How relevant is this candidate to the goal as stated, based on what is known about it?",
  "reading-value": "How valuable is opening or reading this candidate next for the goal? Judge exploration value, not only immediate relevance.",
  "complementary": "Does this candidate likely add information missing from the material already seen for this goal?",
  "duplicate": "Does this candidate likely duplicate material already available for this goal?",
  "continuation": "Is this candidate worth continuing to trace — following its relations, terms, or links — for this goal?",
};

const SCORE_LEVELS = ["none", "low", "moderate", "high"] as const;

/** One answer-to-candidate projection; ordering and failure status belong to the caller. */
const projectCandidates = (params: Pick<ResearchDecideParams, "kind" | "candidates">, result?: HarnessFastDecisionResult): ResearchDecideRankedCandidate[] => {
  if (params.kind === "next") {
    const answer = result?.answers.find(item => item.id === "next" && item.kind === "choose");
    const choice = answer?.kind === "choose" ? answer.choice : null;
    return params.candidates.map(candidate => ({ id: candidate.id, ...(candidate.id === choice ? { selected: true } : {}) }));
  }
  const answers = new Map(result?.answers.filter(item => item.kind === "score").map(item => [item.id, item] as const));
  return params.candidates.map(candidate => {
    const answer = answers.get(candidate.id);
    return answer?.kind === "score" ? { id: candidate.id, score: answer.score,
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }) } : { id: candidate.id };
  });
};

const fallbackResult = (
  params: ResearchDecideParams,
  purpose: "web" | "scholarly",
  status: ResearchDecideResult["status"],
  rejected: ResearchDecideResult["rejected"],
  message?: string,
  known?: { result: HarnessFastDecisionResult; configurationId: string },
): ResearchDecideResult => ({
  status,
  purpose,
  kind: params.kind,
  ranked: projectCandidates({ ...params, candidates: params.candidates
    .filter((candidate) => !rejected.some((item) => item.id === candidate.id)) }, status === "failed" ? known?.result : undefined),
  rejected,
  missing: known?.result.missing ?? [],
  ...(known ? decisionProvenance(known.result, known.configurationId) : {}),
  fallback: "order",
  ...(message !== undefined ? { message } : {}),
});

const decisionProvenance = (result: HarnessFastDecisionResult, configurationId: string): Pick<
  ResearchDecideResult, "providerId" | "modelId" | "servedModelId" | "configurationId" | "usage"
> => ({
  providerId: result.providerId,
  modelId: result.modelId,
  ...(result.servedModelId !== undefined ? { servedModelId: result.servedModelId } : {}),
  configurationId,
  ...(result.usage !== undefined ? { usage: result.usage } : {}),
});

const candidateReadFailure = (result: Exclude<FetchResult, { status: "ok" }>): string => {
  if (result.status === "snapshot-missing") return "snapshot not readable under caller authority";
  const detail = "reason" in result ? result.reason
    : "detail" in result ? result.detail
    : "hint" in result ? result.hint
    : "kind" in result ? result.kind : undefined;
  return `snapshot read ${result.status}${detail ? `: ${detail}` : ""}`;
};

export async function executeResearchDecide(
  params: ResearchDecideParams,
  context: ResearchDecideContext,
): Promise<ResearchDecideResult> {
  const goal = typeof params.goal === "string" ? params.goal.trim() : "";
  if (!goal) throw new HarnessServiceError("invalid-params", "goal must be a non-empty string");
  if (!Array.isArray(params.candidates) || params.candidates.length === 0) {
    throw new HarnessServiceError("invalid-params", "candidates must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const candidate of params.candidates) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim()) {
      throw new HarnessServiceError("invalid-params", "every candidate needs a non-empty id");
    }
    if (seen.has(candidate.id)) {
      throw new HarnessServiceError("invalid-params", `duplicate candidate id "${candidate.id}"`);
    }
    seen.add(candidate.id);
  }

  const purpose: "web" | "scholarly" = params.purpose
    ?? (params.candidates.some((candidate) => candidate.kind === "paper") ? "scholarly" : "web");

  if (context.signal.aborted) return fallbackResult(params, purpose, "cancelled", []);

  // Validate references under the caller's authority before judging. A
  // snapshot id that does not resolve to readable material is rejected —
  // it is never silently judged as if it were real content.
  const rejected: ResearchDecideResult["rejected"] = [];
  const reads = new Map<string, Extract<FetchResult, { status: "ok" }>>();
  for (const candidate of params.candidates) {
    const snapshotId = candidate.kind === "section"
      ? candidate.section?.snapshotId
      : candidate.kind === "snapshot" ? candidate.snapshotId : undefined;
    if (candidate.kind === "snapshot" || candidate.kind === "section") {
      if (!snapshotId) {
        rejected.push({ id: candidate.id, reason: "snapshot reference missing" });
        continue;
      }
      const startLine = candidate.section?.startLine ?? 1;
      const endLine = candidate.section?.endLine ?? startLine + 60;
      if (!Number.isSafeInteger(startLine) || startLine < 1
        || !Number.isSafeInteger(endLine) || endLine < startLine) {
        rejected.push({ id: candidate.id, reason: "section needs positive integer line bounds with endLine >= startLine" });
        continue;
      }
      // The original reader owns ACLs, PDF extraction and line selection.
      // Storage failures must propagate rather than masquerade as ACL denials.
      let content: FetchResult;
      try {
        content = await context.readCandidateText({ snapshotId, startLine, endLine }, context.authority, context.signal);
      } catch (error) {
        if (context.signal.aborted && (error === context.signal.reason
          || (error instanceof Error && error.name === "AbortError"))) {
          return fallbackResult(params, purpose, "cancelled", rejected);
        }
        throw error;
      }
      if (context.signal.aborted) return fallbackResult(params, purpose, "cancelled", rejected);
      if (content.status !== "ok") {
        rejected.push({ id: candidate.id, reason: candidateReadFailure(content) });
        continue;
      }
      if ((content.overview && content.overview.textStatus !== "available") || content.analysis?.status === "unavailable") {
        rejected.push({ id: candidate.id, reason: `snapshot text ${content.overview?.textStatus ?? "unavailable"}` });
        continue;
      }
      reads.set(candidate.id, content);
    } else if (candidate.kind === "url") {
      const url = candidate.url?.trim();
      if (!url || !/^https?:\/\//u.test(url)) {
        rejected.push({ id: candidate.id, reason: "url candidate needs an http(s) url" });
      }
    } else if (candidate.kind === "paper") {
      if (!candidate.paper?.providerId?.trim() || !candidate.paper?.providerRecordId?.trim()) {
        rejected.push({ id: candidate.id, reason: "paper candidate needs providerId and providerRecordId" });
      }
    } else if (candidate.kind === "query") {
      if (!candidate.detail?.trim()) {
        rejected.push({ id: candidate.id, reason: "query candidate needs detail text" });
      }
    }
  }
  const candidates = params.candidates.filter((candidate) => !rejected.some((item) => item.id === candidate.id));

  if (context.signal.aborted) return fallbackResult(params, purpose, "cancelled", rejected);
  if (candidates.length === 0) {
    return fallbackResult(params, purpose, "failed", rejected, "no readable candidates to judge");
  }

  const status = await context.fastDecisionStatus(purpose).catch(() => undefined);
  if (context.signal.aborted) return fallbackResult(params, purpose, "cancelled", rejected);
  if (!status || status.status !== "ready") {
    const resolved = !status ? "unavailable"
      : status.status === "disabled" ? "disabled"
      : status.status === "unconfigured" ? "unconfigured"
      : "unavailable";
    return fallbackResult(
      { ...params, candidates },
      purpose,
      resolved,
      rejected,
      status?.status === "invalid" || status?.status === "unavailable" ? status.message : undefined,
    );
  }

  const materials: FastDecisionMaterial[] = candidates.map((candidate) => {
    const parts = [
      `[${candidate.kind}]`,
      candidate.title,
      candidate.detail,
      candidate.url,
      candidate.paper ? `${candidate.paper.providerId}:${candidate.paper.providerRecordId}${candidate.paper.doi ? ` doi:${candidate.paper.doi}` : ""}` : undefined,
    ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    const description = parts.join("\n");
    const read = reads.get(candidate.id);
    const excerpt = read?.markdown.slice(0, MATERIAL_EXCERPT_LIMIT);
    const hasExcerpt = excerpt !== undefined && excerpt.trim().length > 0;
    const text = (hasExcerpt ? `${description}\n${excerpt}` : description).slice(0, MATERIAL_EXCERPT_LIMIT);
    const label = read ? [
      // These are reader facts. Caller labels remain useful descriptions, but
      // cannot replace the actual derived snapshot or claim unseen text.
      read.snapshot ? `snapshot:${read.snapshot.snapshotId}` : "reader snapshot unavailable",
      ...(read.range ? [`reader lines:${read.range.startLine}..${read.range.endLine}/${read.range.totalLines}`] : []),
      `text prefix:${hasExcerpt ? Math.max(0, text.length - description.length - 1) : 0}/${read.markdown.length} UTF-16 units`,
      ...(read.sourceSnapshot && read.sourceSnapshot.snapshotId !== read.snapshot?.snapshotId
        ? [`source snapshot:${read.sourceSnapshot.snapshotId}`] : []),
      ...(candidate.section?.label !== undefined ? [`caller label:${JSON.stringify(candidate.section.label)}`] : []),
    ].join("; ") : candidate.section?.label
      ?? (candidate.snapshotId ? `snapshot:${candidate.snapshotId}` : undefined)
      ?? (candidate.section?.snapshotId ? `snapshot:${candidate.section.snapshotId}` : undefined);
    return {
      id: candidate.id,
      text,
      ...(label !== undefined ? { label } : {}),
      ...(read?.snapshot ? { revision: read.snapshot.contentHash } : {}),
    };
  });

  const questions: FastDecisionQuestion[] = params.kind === "next"
    ? [{
        id: "next",
        kind: "choose",
        instructions: `Choose the single best material to open next for this goal, or none if no candidate helps.\nGoal: ${goal}`,
        options: candidates.map((candidate) => ({
          id: candidate.id,
          ...(candidate.title ? { detail: candidate.title } : {}),
        })),
        allowNone: true,
      }]
    : candidates.map((candidate) => {
        const kind = params.kind === "next" ? "relevance" : params.kind;
        return {
          id: candidate.id,
          kind: "score" as const,
          instructions: `${KIND_INSTRUCTIONS[kind]}\nEvaluate only the material with candidate ID ${JSON.stringify(candidate.id)}.\nGoal: ${goal}`,
          levels: SCORE_LEVELS,
        };
      });

  let result: HarnessFastDecisionResult;
  try {
    result = await context.fastDecision({
      purpose,
      settings: status.binding,
      goal,
      materials,
      questions,
      signal: context.signal,
    });
  } catch (error) {
    const cancelled = context.signal.aborted || error instanceof ResearchDecisionFailure && error.cancelled;
    const known = error instanceof ResearchDecisionFailure && error.result
      ? { result: error.result, configurationId: status.binding.configurationId }
      : undefined;
    return fallbackResult(
      { ...params, candidates },
      purpose,
      cancelled ? "cancelled" : "failed",
      rejected,
      cancelled ? undefined : error instanceof Error ? error.message : String(error),
      known,
    );
  }

  const known = { result, configurationId: status.binding.configurationId };
  if (context.signal.aborted) {
    return fallbackResult({ ...params, candidates }, purpose, "cancelled", rejected, undefined, known);
  }
  if (result.answers.length === 0) {
    return fallbackResult({ ...params, candidates }, purpose, "failed", rejected, "provider returned no answers", known);
  }

  const missing = new Set(result.missing);
  let ranked = projectCandidates({ ...params, candidates }, result);
  if (params.kind !== "next") {
    // Higher scores lead the ordering; missing/unscored candidates keep
    // their relative order at the end rather than being read as zero.
    const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
    ranked = [...ranked].sort((a, b) => (
      (b.score ?? -1) - (a.score ?? -1) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    ));
  }

  return {
    status: "ok",
    purpose,
    kind: params.kind,
    ranked,
    rejected,
    missing: [...missing].filter((id) => id !== "next" || params.kind === "next"),
    ...decisionProvenance(result, status.binding.configurationId),
  };
}
