import type {
  ExploreGroupedSearchPlan,
  ExploreQueryFollowupParams,
  ExploreQuerySelectionGroup,
  ExploreQueryStartResult,
  ExploreQueryView,
  ExploreQueryViewsResult,
} from "@varin/protocol";

const MECHANISM = /\b(how|why|mechanism|flow|wired|through)\b/iu;
const MECHANISM_HAN = /怎么|如何|为何|机制|流程|为什么|怎样/;
const PATH_LIKE = /[\\/]|\.[a-z][a-z0-9]+$/i;

export function exploreAsksMechanism(question: string): boolean {
  return MECHANISM.test(question) || MECHANISM_HAN.test(question);
}

export function exploreLooksLikePath(question: string): boolean {
  const trimmed = question.trim();
  return PATH_LIKE.test(trimmed) && !/\s/.test(trimmed);
}

export function exploreShouldPlanWithModel(question: string, objects: readonly string[]): boolean {
  if (exploreLooksLikePath(question) && !exploreAsksMechanism(question)) return false;
  if (objects.length > 0 && !exploreAsksMechanism(question) && !hasConceptualRemainder(question, objects)) {
    return false;
  }
  return true;
}

export function exploreShouldSelectWithModel(
  question: string,
  objects: readonly string[],
  planUsed: boolean,
): boolean {
  if (planUsed || exploreAsksMechanism(question)) return true;
  return exploreShouldPlanWithModel(question, objects);
}

function hasConceptualRemainder(question: string, objects: readonly string[]): boolean {
  let rest = question;
  for (const object of objects) rest = rest.split(object).join(" ");
  const tokens = rest.match(/[$_\p{L}][$_\p{L}\p{M}\p{N}]{2,}/gu) ?? [];
  return tokens.some((token) => !/^(where|what|which|find|the|and|for|with|from|this|that|请|帮|找|查|一下)$/iu.test(token));
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function parseExplorePlan(text: string): ExploreGroupedSearchPlan | undefined {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const groupsIn = Array.isArray(record.groups) ? record.groups : [];
  const groups = groupsIn.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const group = item as Record<string, unknown>;
    const expressions = Array.isArray(group.expressions)
      ? group.expressions.filter((expression): expression is string => typeof expression === "string" && expression.trim().length > 0)
      : [];
    if (expressions.length === 0) return [];
    const expectedMaterials = Array.isArray(group.expectedMaterials)
      ? group.expectedMaterials.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return [{
      id: typeof group.id === "string" && group.id.trim() ? group.id.trim() : `g${index + 1}`,
      concept: typeof group.concept === "string" ? group.concept : expressions[0]!,
      expressions,
      ...(expectedMaterials?.length ? { expectedMaterials } : {}),
    }];
  });
  if (groups.length === 0) return undefined;
  return {
    behavior: typeof record.behavior === "string" ? record.behavior : "",
    groups,
  };
}

export function parseExploreSelection(text: string): {
  groups: ExploreQuerySelectionGroup[];
  followup?: Omit<ExploreQueryFollowupParams, "queryId">;
  actionIds: string[];
  done: boolean;
} | undefined {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.groups)) return undefined;
  const groupsIn = Array.isArray(record.groups) ? record.groups : [];
  const groups = groupsIn.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const group = item as Record<string, unknown>;
    const viewsIn = Array.isArray(group.views) ? group.views : [];
    const views = viewsIn.flatMap((view) => {
      if (!view || typeof view !== "object" || Array.isArray(view)) return [];
      const entry = view as Record<string, unknown>;
      if (typeof entry.viewId !== "string" || !entry.viewId.trim()) return [];
      const rangeIds = Array.isArray(entry.rangeIds)
        ? entry.rangeIds.filter((id): id is string => typeof id === "string")
        : undefined;
      return [{
        viewId: entry.viewId.trim(),
        ...(rangeIds?.length ? { rangeIds } : {}),
        ...(typeof entry.startLine === "number" ? { startLine: entry.startLine } : {}),
        ...(typeof entry.endLine === "number" ? { endLine: entry.endLine } : {}),
        ...(typeof entry.required === "boolean" ? { required: entry.required } : { required: true }),
      }];
    });
    if (views.length === 0) return [];
    return [{
      id: typeof group.id === "string" && group.id.trim() ? group.id.trim() : `sel${index + 1}`,
      purpose: typeof group.purpose === "string" ? group.purpose : "",
      views,
      ...(typeof group.gap === "string" && group.gap.trim() ? { gap: group.gap.trim() } : {}),
    }];
  });
  const followupIn = record.followup && typeof record.followup === "object" && !Array.isArray(record.followup)
    ? record.followup as Record<string, unknown>
    : undefined;
  const searches = Array.isArray(followupIn?.searches)
    ? followupIn.searches.flatMap((item) => (
      item && typeof item === "object" && !Array.isArray(item) && typeof (item as { expression?: unknown }).expression === "string"
        ? [{ expression: (item as { expression: string }).expression }]
        : typeof item === "string" && item.trim()
          ? [{ expression: item }]
          : []
    ))
    : [];
  const locates = Array.isArray(followupIn?.locates)
    ? followupIn.locates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const locate = item as Record<string, unknown>;
      if ((locate.kind === "symbol" || locate.kind === "path" || locate.kind === "connect") && typeof locate.value === "string") {
        const kind: "symbol" | "path" | "connect" = locate.kind;
        return [{ kind, value: locate.value }];
      }
      return [];
    })
    : [];
  return {
    groups,
    actionIds: Array.isArray(record.actionIds) ? record.actionIds.filter((id): id is string => typeof id === 'string') : [],
    done: record.done === true,
    ...(searches.length || locates.length
      ? { followup: { ...(searches.length ? { searches } : {}), ...(locates.length ? { locates } : {}) } }
      : {}),
  };
}

export const EXPLORE_PLAN_SYSTEM = [
  "Plan grouped search expressions for the request using the supplied repository vocabulary.",
  "Return a JSON object: {\"behavior\":\"...\",\"groups\":[{\"id\":\"g1\",\"concept\":\"...\",\"expressions\":[\"...\"],\"expectedMaterials\":[\"...\"]}]}",
  "Each group represents a concept; its expressions are match variants. The Host applies the user's path scope.",
].join(" ");

export const EXPLORE_SELECT_SYSTEM = [
  "Select source excerpts that help answer the request.",
  "Source blocks contain file data; query-phase hypotheses are earlier search guesses.",
  "Return a JSON object: {\"groups\":[{\"id\":\"sel1\",\"purpose\":\"...\",\"views\":[{\"viewId\":\"v1\",\"rangeIds\":[\"v1:full\"],\"required\":true}],\"gap\":\"...\"}],\"actionIds\":[],\"followup\":{\"searches\":[{\"expression\":\"...\"}],\"locates\":[{\"kind\":\"symbol\",\"value\":\"...\"}]},\"done\":false}",
  "Select supplied rangeIds, or startLine/endLine within a visible view. A gap describes evidence missing from this batch.",
  "Each response replaces the retained selection, including earlier ranges that remain useful. A group's required ranges are delivered together; required:false marks supplementary ranges. Empty groups are valid.",
  "actionIds selects from the supplied Host operations. followup can request search expressions or locates (symbol, path, connect). Return done:true when the retained material suffices or further retrieval is not useful.",
].join(" ");

export function renderExplorePlanPrompt(start: ExploreQueryStartResult): string {
  return [
    "User request:",
    start.question,
    "",
    "Known objects and anchors (not hard filters):",
    JSON.stringify({ objects: start.parsed.objects, relation: start.parsed.relation, vocab: start.vocab }),
    "",
    "Plan grouped search expressions that can find the behavior in repository vocabulary.",
  ].join("\n");
}

function renderViewBlock(view: ExploreQueryView): string {
  return [
    `view ${view.viewId} ${view.path}:${view.startLine}-${view.endLine} rev=${view.revision}`,
    `ranges ${view.ranges.map((range) => `${range.rangeId} L${range.startLine}-${range.endLine}`).join(", ")}`,
    `assessment ${view.assessment}`,
    `<untrusted-source view="${view.viewId}" path="${view.path}" lines="${view.startLine}-${view.endLine}">`,
    view.text,
    "</untrusted-source>",
  ].join("\n");
}

export function renderExploreSelectPrompt(
  question: string,
  views: ExploreQueryViewsResult,
  mode: "full" | "incremental",
  extras?: {
    newViews?: readonly ExploreQueryView[];
    selectedViews?: readonly ExploreQueryView[];
    excerptLimit?: number;
  },
): string {
  const selected = extras?.selectedViews ?? [];
  const shown = mode === "incremental" ? extras?.newViews ?? views.views : views.views;
  return [
    "User request:",
    question,
    "",
    ...(extras?.excerptLimit !== undefined ? [
      `Output excerpt limit: ${extras.excerptLimit}. Each selected range consumes one excerpt. A group whose required ranges exceed this limit will be rejected.`,
      "",
    ] : []),
    "Query-phase hypotheses (may be wrong):",
    JSON.stringify(views.hypotheses ?? {}),
    "",
    ...(mode === "incremental"
      ? [
        "Already selected source:",
        selected.length > 0 ? selected.map(renderViewBlock).join("\n\n") : "(none)",
        "",
        "Newly read source:",
        shown.map(renderViewBlock).join("\n\n"),
      ]
      : [
        "Current source candidates:",
        shown.map(renderViewBlock).join("\n\n"),
      ]),
    "",
    `Visible delivery budget: ${views.outputByteBudget} UTF-8 bytes including paths, source metadata and gap notices.`,
    `Available operations (choose actionIds): ${JSON.stringify(views.actions)}`,
    `Pending sources: ${views.pending}; additional unassessed views: ${views.unevaluated}`,
  ].join("\n");
}
