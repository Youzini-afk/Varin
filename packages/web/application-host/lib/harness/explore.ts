import { languageIdForPath, type ExploreArrival, type ExploreAssessment, type ExploreDistinctivenessDetails, type ExploreFastDecisionDetails, type ExploreGraphDetails, type ExploreGraphStatus, type ExploreGroupedSearchPlan, type ExploreIndexLifecycle, type ExploreModelParticipation, type ExplorePurpose, type ExploreQueryAction, type ExploreQueryFollowupParams, type ExploreQuerySelectResult, type ExploreQuerySelectionGroup, type ExploreQuerySourceState, type ExploreQueryView, type ExploreQueryVocab, type ExploreRerankDetails, type ExploreRerankScore, type ExploreSemanticCoverage, type ExploreSemanticDetails, type ExploreSemanticGap, type ExploreSemanticStatus, type ExploreTermCoverage, type ExploreWindowTrace, type HarnessServiceMap } from "@varin/protocol";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { SMALL_STRUCTURE_SPAN_LINES } from "../structure/constants.js";
import { classifyLiteralCall } from "../structure/connections.js";
import { outlineUsableForText, sliceStructureWindows } from "../structure/slice.js";
import type { StructureHitClass, StructureOutlineResult, StructureSource } from "../structure/types.js";
import {
  DEFAULT_ANCHOR_CAP,
  buildRgPatterns,
  buildTermGroups,
  classifyFileRole,
  exploreIsExplicitNavigation,
  extractIdentifierGroups,
  extractIdentifiers,
  extractQuotedLiterals,
  fileRoleFit,
  looksLikeConnectionValue,
  looksLikePathObject,
  looksLikeSymbolName,
  parseExploreQuery,
  type ExploreQueryParse,
  type TermGroup,
  type TermGroupKind,
} from "./explore-query.js";
import {
  buildTermWeightTable,
  coverageFromSearch,
  weightByGroupId,
  weightedCoverage,
  type PatternCoverage,
} from "./explore-distinctiveness.js";
import {
  DEFAULT_GRAPH_CONNECTION_BUDGET,
  DEFAULT_GRAPH_DEFINITION_BUDGET,
  DEFAULT_GRAPH_DEFINITIONS_PER_TERM,
  DEFAULT_GRAPH_IMPORT_BUDGET,
  DEFAULT_GRAPH_IMPORT_PER_SEED,
  DEFAULT_GRAPH_RELATION_BUDGET,
  locateIdentifierLines,
  locateLiteralLines,
  pathInRoots,
  rankReverseImporters,
  type ExploreGraphRecall,
} from "./explore-graph.js";
import { fuseFileRanks } from "./explore-rrf.js";
import { relocateSemanticFocus } from "../knowledge/semantic/relocate.js";

export {
  DEFAULT_ANCHOR_CAP,
  buildRgPatterns,
  buildTermGroups,
  extractIdentifierGroups,
  extractIdentifiers,
  extractQuotedLiterals,
  parseExploreQuery,
};
export type { TermGroup, TermGroupKind };

type WireResult = HarnessServiceMap["explore.search"]["result"];
export type ExploreSnippet = WireResult["snippets"][number];
export type ExploreIssue = WireResult["issues"][number];
export type ExploreProvenance = WireResult["details"]["provenance"][number];

export interface RgHit {
  path: string;
  line: number;
  /** The full matched line, without its line terminator. */
  text: string;
}

export type RgSearchReturn = RgHit[] | {
  hits: RgHit[];
  partial?: boolean;
  filesDropped?: number;
  fileCoverage?: ExploreTermCoverage;
};

export interface ExploreInput {
  question: string;
  paths?: string[];
  limit?: number;
  anchors?: string[];
}

export interface ExploreRgSearchOptions {
  fixedStrings: boolean;
  paths?: string[];
  candidateBudget?: number;
  hitsPerFile?: number;
}

export type ExploreSemanticHit = {
  documentId: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  body: string;
  similarity: number;
  rank: number;
};

export type ExploreSemanticSearch = {
  status: ExploreSemanticStatus;
  coverage: ExploreSemanticCoverage;
  note?: string;
  generation?: string;
  spaceId?: string;
  scope?: { scopeKind: string; scopeId: string };
  lifecycle: ExploreIndexLifecycle;
  hits: ExploreSemanticHit[];
  gaps?: ExploreSemanticGap[];
};

export interface ExploreDeps {
  rgSearch(pattern: string, options: ExploreRgSearchOptions): Promise<RgSearchReturn>;
  readFile(path: string): Promise<ExploreFileSnapshot>;
  structure?: Pick<StructureSource, "outline" | "classifyHits"> & Partial<Pick<StructureSource, "literalCalls">>;
  graph?: ExploreGraphRecall;
  semantic?: {
    search(question: string, limit?: number, signal?: AbortSignal): Promise<ExploreSemanticSearch>;
  };
}

export interface ExploreResult {
  snippets: ExploreSnippet[];
  issues: ExploreIssue[];
  notRequested: { count: number; paths: string[] };
  omitted: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
  partial: boolean;
  searchIncomplete: boolean;
  searched: WireResult["searched"];
  details: WireResult["details"];
}

/** Output excerpt count default. `limit` is a cap, not a quota. */
export const DEFAULT_EXCERPT_LIMIT = 20;
/** Working candidate-hit budget per generic/literal/identifier pattern. */
export const DEFAULT_CANDIDATE_BUDGET = 200;
/** Independent working budget for each anchor pattern. */
export const DEFAULT_ANCHOR_BUDGET = 80;
/** Per-file hit cap inside the candidate pool (not a product hard reject). */
export const DEFAULT_HITS_PER_FILE = 12;
export const DEFAULT_READ_PARALLELISM = 3;
export const DEFAULT_READ_LOOKAHEAD = 2;
/** Below the 32 KiB generic tool-result truncation so explore packs first. */
export const DEFAULT_BYTE_BUDGET = 24 * 1024;
/** Working nearest-neighbor budget. Not a product hard reject. */
export const DEFAULT_SEMANTIC_RECALL = 24;
/** Candidate-model input budget, separate from the 24 KiB agent-visible pack. */
export const DEFAULT_MODEL_INPUT_BYTES = 48 * 1024;
/** Reserved from the public remaining wait for judge/present. Not a calibrated SLO. */
export const DEFAULT_JUDGE_RESERVE_MS = 8_000;
/** Public explore remaining wait shared across stages. Not a calibrated SLO. */
export const DEFAULT_EXPLORE_QUERY_BUDGET_MS = 120_000;

export function exploreHandleHint(handle: string): string {
  return `\nMore: get_output("${handle}") for the full pack and unread candidate list (session-local, ephemeral).`;
}

const VOCAB_PACKAGE_LIMIT = 12;
const VOCAB_ENTRY_LIMIT = 12;

export function vocabFromCatalog(stats: { symbolCount: number; fileCount?: number; paths?: string[] }): {
  catalog: { symbolCount: number; fileCount?: number };
  packages?: string[];
  entries?: string[];
} {
  const catalog = {
    symbolCount: stats.symbolCount,
    ...(stats.fileCount !== undefined ? { fileCount: stats.fileCount } : {}),
  };
  const normalized = (stats.paths ?? []).map((path) => path.replace(/\\/g, "/"));
  const packages = [...new Set(normalized.flatMap((path) => {
    if (/(^|\/)package\.json$/i.test(path)) {
      const slash = path.lastIndexOf("/");
      return [slash <= 0 ? "." : path.slice(0, slash)];
    }
    // The symbol catalog intentionally does not index package.json. Derive the
    // package root from catalogued source paths in the monorepo layout instead
    // of testing a path shape production can never provide.
    const workspacePackage = /^(packages|apps)\/[^/]+(?=\/|$)/u.exec(path)?.[0];
    return workspacePackage ? [workspacePackage] : [];
  }))].slice(0, VOCAB_PACKAGE_LIMIT);
  const entries = normalized
    .filter((path) => /(^|\/)(index|main|cli)\.[cm]?[jt]sx?$/i.test(path))
    .slice(0, VOCAB_ENTRY_LIMIT);
  return {
    catalog,
    ...(packages.length > 0 ? { packages } : {}),
    ...(entries.length > 0 ? { entries } : {}),
  };
}

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const normalizeRgResult = (value: RgSearchReturn): {
  hits: RgHit[];
  partial: boolean;
  filesDropped: number;
  fileCoverage: ExploreTermCoverage;
} => {
  if (Array.isArray(value)) {
    return { hits: value, partial: false, filesDropped: 0, fileCoverage: "unknown" };
  }
  const filesDropped = value.filesDropped ?? 0;
  const partial = value.partial === true;
  return {
    hits: value.hits,
    partial,
    filesDropped,
    fileCoverage: coverageFromSearch({
      filesDropped,
      ...(value.fileCoverage ? { fileCoverage: value.fileCoverage } : {}),
      partial,
    }),
  };
};

export function maxMaterializeReads(candidateCount: number, excerptLimit: number): number {
  return Math.min(
    candidateCount,
    DEFAULT_READ_PARALLELISM + Math.max(excerptLimit, DEFAULT_READ_LOOKAHEAD),
  );
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const searchVariantsOf = (group: TermGroup): string[] => {
  if (group.kind === "anchor" || group.kind === "literal" || group.kind === "question" || group.kind === "plan") {
    return group.variants;
  }
  return group.variants.filter((variant) => variant === group.distinctive || variant.length > 1);
};

type GraphCandidateSource = "definition" | "connection" | "association" | "import" | "references" | "calls" | "callers" | "action";
/** Why this graph edge was walked (D-163). Same-container is ordinary supplement. */
export type GraphArrivalReason = "object-triggered" | "statement-evidence" | "same-container";

interface SemanticClue {
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  body: string;
  similarity: number;
  rank: number;
}

interface GraphClue {
  source: GraphCandidateSource;
  why: string;
  locate: { text: string; kind: "identifier" | "literal" };
  arrivalReason: GraphArrivalReason;
  edgeKind?: "connects" | "associates" | "definition" | "import" | "references" | "calls" | "action";
  match?: "exact" | "name-contains";
  callee?: string;
  /**
   * Reached by completing a wire whose literal is unrelated to the question
   * object. A registration table window holds every service it registers, so
   * expanding it would otherwise pack unrelated counterparts at connects grade
   * (D-151).
   */
  offTopic?: true;
}

interface FileEvidence {
  hits: Map<number, { text: string; groups: Set<string>; distinctive: Set<string>; clues: GraphClue[] }>;
  groups: Set<string>;
  distinctive: Set<string>;
  anchors: Set<string>;
  graphClues: GraphClue[];
  semanticClues: SemanticClue[];
  /**
   * Line ranges a chosen follow-up action asked to materialize (D-312). They
   * become slice focuses exactly like hit lines and semantic blocks.
   */
  readFocuses: Array<{ startLine: number; endLine: number; why: string }>;
  verifiedRelation: boolean;
  verifiedCallees: Set<string>;
}

interface RankedCandidate {
  path: string;
  evidence: FileEvidence;
  roleFit: number;
  rrf: number;
  hasRankedSource: boolean;
}

interface PreparedWindow {
  path: string;
  start: number;
  end: number;
  text: string;
  groups: Set<string>;
  distinctive: Set<string>;
  hasDistinctive: boolean;
  hasAnchor: boolean;
  offTopic: boolean;
  windowWeight: number;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch";
  why: string;
  unit?: ExploreSnippet["unit"];
  structure?: ExploreSnippet["structure"];
  hitLines: number[];
  hitClass?: StructureHitClass;
  arrivals: ExploreArrival[];
  assessment: ExploreAssessment;
  purpose: ExplorePurpose;
  verifiedCallees: string[];
  verifiedRelations: Array<{ callee: string; literal: string }>;
  factKey: string;
  roleFit: number;
}

const emptyEvidence = (): FileEvidence => ({
  hits: new Map(),
  groups: new Set(),
  distinctive: new Set(),
  anchors: new Set(),
  graphClues: [],
  semanticClues: [],
  readFocuses: [],
  verifiedRelation: false,
  verifiedCallees: new Set(),
});

const ASSESSMENT_RANK: Record<ExploreAssessment, number> = {
  "verified-relation": 3,
  "object-present": 2,
  "name-only": 1,
  unverified: 0,
};

const ARRIVAL_RANK: Record<GraphArrivalReason, number> = {
  "object-triggered": 2,
  "statement-evidence": 1,
  "same-container": 0,
};

function attachGraphClue(evidence: FileEvidence, clue: GraphClue): void {
  const existing = evidence.graphClues.find((item) => (
    item.source === clue.source && item.why === clue.why && item.locate.text === clue.locate.text
  ));
  if (!existing) {
    evidence.graphClues.push(clue);
    return;
  }
  if (ARRIVAL_RANK[clue.arrivalReason] > ARRIVAL_RANK[existing.arrivalReason]) {
    existing.arrivalReason = clue.arrivalReason;
    if (clue.offTopic) existing.offTopic = true;
    else delete existing.offTopic;
  }
}

function objectMatchesValue(object: string, value: string): boolean {
  return value === object || value.includes(object) || object.includes(value);
}

function literalOnHitLine(literal: string, windows: readonly PreparedWindow[]): boolean {
  for (const window of windows) {
    if (!window.text.includes(literal)) continue;
    const lines = window.text.split(/\r\n|\n|\r/);
    for (const hitLine of window.hitLines) {
      const text = lines[hitLine - window.start];
      if (text?.includes(literal)) return true;
    }
  }
  return false;
}

function arrivalForLiteral(
  literal: string,
  parsed: ExploreQueryParse,
  windows: readonly PreparedWindow[],
): GraphArrivalReason {
  if (parsed.objects.some((object) => objectMatchesValue(object, literal))) return "object-triggered";
  if (literalOnHitLine(literal, windows)) return "statement-evidence";
  return "same-container";
}

function arrivalForImport(
  specifier: string,
  seedPath: string,
  parsed: ExploreQueryParse,
  windows: readonly PreparedWindow[],
): GraphArrivalReason {
  if (parsed.objects.some((object) => objectMatchesValue(object, specifier) || objectMatchesValue(object, seedPath))) {
    return "object-triggered";
  }
  // An import whose specifier sits on a hit line of the current body is the
  // same statement evidence a connection literal would be. Without this an
  // object-less question can never reach a direct import clue (D-172).
  if (literalOnHitLine(specifier, windows)) return "statement-evidence";
  return "same-container";
}

function isDirectArrival(reason: GraphArrivalReason): boolean {
  return reason === "object-triggered" || reason === "statement-evidence";
}

function isDirectConnectionClue(clue: GraphClue): boolean {
  return clue.source === "connection" && isDirectArrival(clue.arrivalReason) && !clue.offTopic;
}

function applyGraphLocate(lines: readonly string[], evidence: FileEvidence): void {
  for (const clue of evidence.graphClues) {
    const found = clue.locate.kind === "identifier"
      ? locateIdentifierLines(lines, clue.locate.text)
      : locateLiteralLines(lines, clue.locate.text);
    for (const line of found) {
      const existing = evidence.hits.get(line);
      if (existing) {
        if (!existing.clues.some((item) => item.why === clue.why && item.locate.text === clue.locate.text)) {
          existing.clues.push(clue);
        }
        continue;
      }
      evidence.hits.set(line, {
        text: lines[line - 1]!,
        groups: new Set(),
        distinctive: new Set(),
        clues: [clue],
      });
    }
  }
}

function recordHit(byFile: Map<string, FileEvidence>, hit: RgHit, group: TermGroup, distinctive: boolean): void {
  const evidence = byFile.get(hit.path) ?? emptyEvidence();
  const line = evidence.hits.get(hit.line) ?? {
    text: hit.text,
    groups: new Set<string>(),
    distinctive: new Set<string>(),
    clues: [],
  };
  line.text = hit.text;
  line.groups.add(group.id);
  if (distinctive) line.distinctive.add(group.id);
  evidence.hits.set(hit.line, line);
  evidence.groups.add(group.id);
  if (distinctive) evidence.distinctive.add(group.id);
  if (group.kind === "anchor") evidence.anchors.add(group.id);
  byFile.set(hit.path, evidence);
}

function objectGroupsOf(groups: TermGroup[]): TermGroup[] {
  return groups.filter((group) => group.kind === "anchor" || group.kind === "literal" || group.kind === "identifier");
}

function contentGroupsOf(groups: TermGroup[]): TermGroup[] {
  return groups.filter((group) => group.kind === "question");
}

const termLocate = (lines: readonly string[], term: string, group: TermGroup): number[] => {
  if (!term) return [];
  if (group.kind === "literal" || looksLikeConnectionValue(term) || term.includes("-")) {
    return locateLiteralLines(lines, term);
  }
  return locateIdentifierLines(lines, term);
};

/**
 * After a snapshot is in hand, check every live group against the body.
 * rg's candidate budget can drop the line we need; the file is already paid
 * for. Seed at most one hit per group that has no hit yet (D-155).
 */
function rescanBodyGroups(lines: readonly string[], groups: readonly TermGroup[], evidence: FileEvidence): void {
  for (const group of groups) {
    const found: Array<{ line: number; distinctive: boolean }> = [];
    for (const variant of searchVariantsOf(group)) {
      const distinctive = variant === group.distinctive;
      for (const line of termLocate(lines, variant, group)) {
        const existing = found.find((item) => item.line === line);
        if (existing) {
          if (distinctive) existing.distinctive = true;
          continue;
        }
        found.push({ line, distinctive });
      }
    }
    if (found.length === 0) continue;
    evidence.groups.add(group.id);
    if (found.some((item) => item.distinctive)) evidence.distinctive.add(group.id);
    if (group.kind === "anchor") evidence.anchors.add(group.id);
    // Seed original-term lines that are not already inside an existing
    // hit's small container. One early mention must not hide a later
    // cluster of the same group (D-155).
    if (!found.some((item) => item.distinctive)) continue;
    const existing = [...evidence.hits.entries()]
      .filter(([, hit]) => hit.groups.has(group.id))
      .map(([line]) => line);
    let seeded = 0;
    for (const seed of found.filter((item) => item.distinctive)) {
      if (existing.some((line) => Math.abs(line - seed.line) < SMALL_STRUCTURE_SPAN_LINES)) continue;
      const line = evidence.hits.get(seed.line) ?? {
        text: lines[seed.line - 1]!,
        groups: new Set<string>(),
        distinctive: new Set<string>(),
        clues: [],
      };
      line.groups.add(group.id);
      line.distinctive.add(group.id);
      evidence.hits.set(seed.line, line);
      existing.push(seed.line);
      seeded += 1;
      if (seeded >= 3) break;
    }
  }
}

function lexicalFileRanks(
  byFile: Map<string, FileEvidence>,
  groups: TermGroup[],
  weights: ReadonlyMap<string, number>,
): Map<string, number> {
  const ordered = [...byFile.entries()]
    .filter(([, evidence]) => evidence.hits.size > 0 || evidence.groups.size > 0)
    .map(([path, evidence]) => ({ path, score: weightedCoverage(evidence, groups, weights) }))
    .sort((left, right) => right.score - left.score || comparePath(left.path, right.path));
  const ranks = new Map<string, number>();
  let rank = 0;
  let previousScore: number | undefined;
  ordered.forEach((item, index) => {
    if (item.score !== previousScore) {
      rank = index + 1;
      previousScore = item.score;
    }
    ranks.set(item.path, rank);
  });
  return ranks;
}

/** Same-tier order: file-level RRF when a semantic source is present, else weighted coverage (D-170). */
function rankCandidates(
  byFile: Map<string, FileEvidence>,
  groups: TermGroup[],
  parsed: ExploreQueryParse,
  table: ExploreDistinctivenessDetails,
): RankedCandidate[] {
  const weights = weightByGroupId(groups, table);
  const lexicalRanks = lexicalFileRanks(byFile, groups, weights);
  return [...byFile.entries()]
    .map(([path, evidence]) => {
      const role = classifyFileRole(path);
      const fit = fileRoleFit(role, parsed.domain, parsed.preferTests);
      const semanticRank = evidence.semanticClues.length > 0
        ? Math.min(...evidence.semanticClues.map((clue) => clue.rank))
        : undefined;
      const lexicalRank = lexicalRanks.get(path);
      const hasRankedSource = lexicalRank !== undefined || semanticRank !== undefined;
      const rrf = fuseFileRanks({
        ...(lexicalRank !== undefined ? { lexical: lexicalRank } : {}),
        ...(semanticRank !== undefined ? { semantic: semanticRank } : {}),
      });
      return {
        path,
        evidence,
        roleFit: fit,
        rrf,
        hasRankedSource,
      };
    })
    .sort((left, right) => (
      Number(right.hasRankedSource) - Number(left.hasRankedSource)
      || right.rrf - left.rrf
      || right.roleFit - left.roleFit
      || comparePath(left.path, right.path)
    ));
}

function primaryObjectFor(evidence: FileEvidence, groups: TermGroup[], parsed: ExploreQueryParse): string {
  for (const object of parsed.objects) {
    const group = groups.find((item) => item.distinctive === object);
    if (group && (evidence.distinctive.has(group.id) || evidence.groups.has(group.id))) return object;
    if (evidence.graphClues.some((clue) => clue.locate.text === object)) return object;
  }
  return parsed.objects[0] ?? "";
}

function isDirectClue(evidence: FileEvidence, groups: TermGroup[], parsed: ExploreQueryParse): boolean {
  if (evidence.graphClues.some(isDirectConnectionClue)) return true;
  // A language-server-resolved call edge to a question object is the resolved
  // counterpart of a confirmed connection literal (D-240).
  if (evidence.graphClues.some((clue) => (
    clue.source === "calls" && isDirectArrival(clue.arrivalReason) && !clue.offTopic
  ))) return true;
  if (evidence.graphClues.some((clue) => (
    clue.source === "definition"
    && clue.match === "exact"
    && parsed.objects.includes(clue.locate.text)
  ))) return true;
  if (evidence.anchors.size > 0) return true;
  return objectGroupsOf(groups).some((group) => (
    (group.kind === "literal" || group.kind === "anchor") && evidence.distinctive.has(group.id)
  ));
}

function scheduleReads(ranked: RankedCandidate[], groups: TermGroup[], parsed: ExploreQueryParse): RankedCandidate[] {
  const directs = ranked.filter((candidate) => isDirectClue(candidate.evidence, groups, parsed));
  const rest = ranked.filter((candidate) => !isDirectClue(candidate.evidence, groups, parsed));
  const buckets = new Map<string, RankedCandidate[]>();
  for (const candidate of directs) {
    const key = primaryObjectFor(candidate.evidence, groups, parsed) || candidate.path;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }
  const interleaved: RankedCandidate[] = [];
  const queues = [...buckets.values()];
  let index = 0;
  while (queues.some((queue) => queue.length > 0)) {
    const queue = queues[index % queues.length]!;
    const next = queue.shift();
    if (next) interleaved.push(next);
    index += 1;
  }
  return [...interleaved, ...rest];
}

function windowLooksLikeCallee(text: string, callee: string, object: string): boolean {
  const escaped = object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${callee}\\(\\s*["'\`]${escaped}`, "u").test(text);
}

/**
 * Cheap identity of "what this file's evidence says right now". Windows are
 * rebuilt when it moves, so a hit or clue that arrived after the read still
 * reaches the model.
 */
function evidenceSignature(evidence: FileEvidence): string {
  const lines = [...evidence.hits.keys()].sort((left, right) => left - right).join(",");
  const groups = [...evidence.groups].sort().join(",");
  const semantic = evidence.semanticClues
    .map((clue) => `${clue.blockId}:${clue.contentHash}:${clue.startLine}-${clue.endLine}:${clue.rank}`)
    .sort()
    .join(",");
  const focuses = evidence.readFocuses
    .map((focus) => `${focus.startLine}-${focus.endLine}:${focus.why}`)
    .sort()
    .join(",");
  return `${lines}|${groups}|${evidence.graphClues.length}|${semantic}|${focuses}|${evidence.verifiedRelation ? 1 : 0}`;
}

/**
 * A wire literal found by reading is off topic when the question named an
 * object and the literal is neither that object nor part of it. No object
 * means we cannot judge off-topic — that is not the same as proven on-topic
 * (D-156).
 */
function literalOffTopic(literal: string, parsed: ExploreQueryParse): boolean {
  if (parsed.objects.length === 0) return false;
  return !parsed.objects.some((object) => (
    literal === object || literal.includes(object) || object.includes(literal)
  ));
}

function windowAssessment(
  windowClues: GraphClue[],
  hasDistinctiveObject: boolean,
  hasAnchor: boolean,
  verified: boolean,
  hasCoveredNames: boolean,
): ExploreAssessment {
  if (verified) return "verified-relation";
  if (hasAnchor || hasDistinctiveObject) return "object-present";
  if (windowClues.some(isDirectConnectionClue) || hasCoveredNames) return "name-only";
  return "unverified";
}

function arrivalsForWindow(
  covered: ReadonlySet<string>,
  names: readonly string[],
  windowClues: readonly GraphClue[],
  semanticClues: readonly SemanticClue[] = [],
): ExploreArrival[] {
  const arrivals: ExploreArrival[] = [];
  if (covered.size > 0) {
    arrivals.push({ kind: "lexical", groups: [...covered], hits: [...names] });
  }
  for (const clue of semanticClues) {
    if (arrivals.some((item) => item.kind === "semantic" && item.blockId === clue.blockId)) continue;
    arrivals.push({
      kind: "semantic",
      blockId: clue.blockId,
      rank: clue.rank,
      similarity: clue.similarity,
    });
  }
  for (const clue of windowClues) {
    if (arrivals.some((item) => (
      item.kind === "graph"
      && item.arrivalReason === clue.arrivalReason
      && item.edgeKind === (clue.edgeKind ?? clue.source)
    ))) continue;
    const edgeKind = clue.edgeKind ?? (
      clue.source === "definition" ? "definition"
        : clue.source === "import" ? "import"
          : clue.source === "association" ? "associates"
            : clue.source === "references" ? "references"
              : clue.source === "calls" ? "calls"
                : clue.source === "action" ? "action"
                  : "connects"
    );
    arrivals.push({
      kind: "graph",
      arrivalReason: clue.arrivalReason,
      edgeKind,
    });
  }
  return arrivals;
}

function windowsFor(
  path: string,
  lines: string[],
  evidence: FileEvidence,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  groups: TermGroup[],
  outline: StructureOutlineResult | { status: "not-requested"; provider: null },
  parsed: ExploreQueryParse,
  weights: ReadonlyMap<string, number>,
): { windows: PreparedWindow[]; stale: boolean } {
  const matches: number[] = [];
  let stale = false;
  for (const [line, hit] of evidence.hits) {
    if (!Number.isSafeInteger(line) || line < 1 || lines[line - 1] !== hit.text) stale = true;
    else matches.push(line);
  }
  matches.sort((a, b) => a - b);
  const languageId = languageIdForPath(path);
  const usable = outlineUsableForText(outline, snapshot.revision)
    ? outline
    : outline.status === "not-requested"
      ? outline
      : {
        status: outline.status === "ready" && outline.revision !== snapshot.revision ? "stale" as const : outline.status,
        provider: outline.provider,
        revision: snapshot.revision,
        symbols: [] as StructureOutlineResult["symbols"],
      };
  const semanticFocuses = evidence.semanticClues.map((clue) => {
    const relocated = relocateSemanticFocus({
      lines,
      languageId,
      recorded: clue,
      symbols: "symbols" in usable ? usable.symbols : [],
    });
    return { ...relocated, clue };
  });
  const slices = sliceStructureWindows({
    path,
    lines,
    revision: snapshot.revision,
    focusRanges: [
      ...matches.map((line) => ({ startLine: line, endLine: line, origin: "lexical-hit" as const })),
      ...semanticFocuses.map((focus) => ({
        startLine: focus.startLine,
        endLine: focus.endLine,
        origin: "semantic-block" as const,
      })),
      ...evidence.readFocuses.map((focus) => ({
        startLine: focus.startLine,
        endLine: focus.endLine,
        origin: "action-read" as const,
      })),
    ],
    outline: usable,
  });
  const nameById = new Map(groups.map((group) => [group.id, group.distinctive]));
  const objectIds = new Set(objectGroupsOf(groups).map((group) => group.id));
  const windows = slices.map((slice) => {
    const covered = new Set<string>();
    const distinctive = new Set<string>();
    const windowClues: GraphClue[] = [];
    let hasAnchor = false;
    const focusLines = new Set<number>(slice.hitLines);
    for (const focus of slice.focusRanges) {
      for (let line = focus.startLine; line <= focus.endLine; line += 1) focusLines.add(line);
    }
    for (const line of focusLines) {
      const hit = evidence.hits.get(line);
      if (!hit) continue;
      for (const groupId of hit.groups) covered.add(groupId);
      for (const groupId of hit.distinctive) distinctive.add(groupId);
      for (const clue of hit.clues) {
        if (!windowClues.some((item) => item.why === clue.why && item.locate.text === clue.locate.text)) {
          windowClues.push(clue);
        }
      }
    }
    for (const groupId of covered) {
      if (evidence.anchors.has(groupId)) hasAnchor = true;
    }
    const names = [...covered].map((id) => nameById.get(id) ?? id);
    const semanticForWindow = semanticFocuses
      .filter((focus) => focus.startLine <= slice.end && focus.endLine >= slice.start)
      .map((focus) => focus.clue);
    const matched = names.length === 1
      ? `matched ${names[0]}`
      : names.length > 1
        ? `matched ${names.length} term groups (${names.join(", ")})`
        : "";
    const whyParts = [
      ...windowClues.map((clue) => clue.why),
      ...semanticForWindow.map((clue) => `semantic neighbor rank ${clue.rank}`),
    ];
    const why = whyParts.length > 0
      ? (matched ? `${whyParts.join("; ")}; ${matched}` : whyParts.join("; "))
      : (matched || "matched search terms");
    const hasDistinctiveObject = [...covered].some((id) => objectIds.has(id) && distinctive.has(id));
    const verified = evidence.verifiedRelation && windowClues.some((clue) => clue.source === "connection" || clue.why.startsWith("verified "));
    const looksLikeRegister = parsed.objects.some((object) => windowLooksLikeCallee(slice.text, "register", object));
    const assessment = looksLikeRegister && parsed.relation === "register"
      ? (verified ? "verified-relation" : (hasDistinctiveObject ? "object-present" : "name-only"))
      : windowAssessment(
        windowClues,
        hasDistinctiveObject,
        hasAnchor,
        verified || evidence.verifiedRelation && hasDistinctiveObject,
        covered.size > 0,
      );
    const arrivals = arrivalsForWindow(covered, names, windowClues, semanticForWindow);
    const offTopic = windowClues.some((clue) => clue.offTopic)
      && !hasDistinctiveObject
      && !verified
      && !windowClues.some(isDirectConnectionClue);
    const structure = outline.status === "not-requested"
      ? undefined
      : {
        provider: outline.provider,
        status: usable.status === "not-requested" ? "not-requested" as const : usable.status,
      };
    const factKey = windowClues[0]
      ? `${path}:${windowClues[0]!.source}:${windowClues[0]!.locate.text}`
      : semanticForWindow[0]
        ? `${path}:semantic:${semanticForWindow[0]!.blockId}`
        : `${path}:${slice.start}:${[...covered].sort().join(",")}`;
    const roleFit = fileRoleFit(classifyFileRole(path), parsed.domain, parsed.preferTests);
    return {
      path,
      start: slice.start,
      end: slice.end,
      text: slice.text,
      groups: covered,
      distinctive,
      hasDistinctive: distinctive.size > 0,
      hasAnchor,
      offTopic,
      windowWeight: weightedCoverage({ groups: covered, distinctive }, groups, weights),
      revision: snapshot.revision,
      source: snapshot.source,
      why,
      ...(slice.unit ? { unit: slice.unit } : {}),
      ...(structure ? { structure } : {}),
      hitLines: slice.hitLines,
      arrivals,
      assessment,
      purpose: "candidate" as const,
      verifiedCallees: [...evidence.verifiedCallees],
      verifiedRelations: [],
      factKey,
      roleFit,
    };
  });
  return { windows, stale };
}

const HIT_CLASS_RANK: Record<StructureHitClass, number> = {
  name: 3,
  body: 2,
  string: 1,
  comment: 0,
};

const bestHitClass = (classes: StructureHitClass[]): StructureHitClass | undefined => {
  let best: StructureHitClass | undefined;
  for (const item of classes) {
    if (!best || HIT_CLASS_RANK[item] > HIT_CLASS_RANK[best]) best = item;
  }
  return best;
};

async function classifyPreparedWindows(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  windows: PreparedWindow[],
  deps: ExploreDeps,
  signal: AbortSignal,
): Promise<PreparedWindow[]> {
  if (!deps.structure || windows.length === 0) return windows;
  const lines = [...new Set(windows.flatMap((window) => window.hitLines))];
  if (lines.length === 0) return windows;
  try {
    signal.throwIfAborted();
    const classified = await deps.structure.classifyHits({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      lines,
      signal,
    });
    signal.throwIfAborted();
    if (classified.status !== "ready") return windows;
    const byLine = new Map(classified.hits.map((hit) => [hit.line, hit.class]));
    return windows.map((window) => {
      const hitClass = bestHitClass(
        window.hitLines.flatMap((line) => {
          const item = byLine.get(line);
          return item ? [item] : [];
        }),
      );
      return hitClass ? { ...window, hitClass } : window;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return windows;
  }
}

function weakenUnverifiedConnectionWhy(windows: PreparedWindow[], objects: readonly string[]): PreparedWindow[] {
  return windows.map((window) => {
    if (window.assessment === "verified-relation") return window;
    if (!objects.some((object) => window.text.includes(object))) return window;
    if (!/graph pointed here|other end of connection|associated mention/.test(window.why)) return window;
    if (/verified register|verified request|verified connection/.test(window.why)) return window;
    return {
      ...window,
      why: window.why.includes("full literal hit")
        ? window.why
        : `${window.why}; full literal hit; graph pointed here`,
    };
  });
}

async function verifyMaterializedRelations(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  evidence: FileEvidence,
  windows: PreparedWindow[],
  parsed: ExploreQueryParse,
  deps: ExploreDeps,
  signal: AbortSignal,
): Promise<PreparedWindow[]> {
  const objects = [...parsed.objects, ...parsed.usedAnchors].filter(Boolean);
  if (objects.length === 0) return windows;
  if (!deps.structure?.literalCalls) {
    return weakenUnverifiedConnectionWhy(windows, objects);
  }
  try {
    signal.throwIfAborted();
    const calls = await deps.structure.literalCalls({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      signal,
    });
    signal.throwIfAborted();
    if (calls.status !== "ready") return weakenUnverifiedConnectionWhy(windows, objects);
    const verified: Array<{ line: number; name: string; literal: string; kind: "connects" | "associates" }> = [];
    for (const call of calls.calls) {
      if (!objects.includes(call.literal)) continue;
      const kind = classifyLiteralCall(call);
      if (!kind) continue;
      verified.push({ line: call.line, name: call.name, literal: call.literal, kind });
    }
    if (verified.length === 0) return weakenUnverifiedConnectionWhy(windows, objects);
    return windows.map((window) => {
      const hit = verified.find((item) => item.line >= window.start && item.line <= window.end);
      if (!hit) return window;
      if (hit.kind === "associates") {
        const why = `associated mention of "${hit.literal}" via ${hit.name}()`;
        return {
          ...window,
          assessment: window.assessment === "verified-relation" ? window.assessment : "unverified",
          why: window.why.includes(why) ? window.why : (window.why ? `${why}; ${window.why}` : why),
        };
      }
      evidence.verifiedRelation = parsed.relation === "unknown" || parsed.relation === "register" || hit.name === "register" || hit.name === "request";
      evidence.verifiedCallees.add(hit.name);
      const why = `verified ${hit.name}("${hit.literal}")`;
      return {
        ...window,
        assessment: "verified-relation",
        verifiedCallees: [...new Set([...window.verifiedCallees, hit.name])],
        verifiedRelations: [...window.verifiedRelations, { callee: hit.name, literal: hit.literal }]
          .filter((item, index, list) => list.findIndex((other) => other.callee === item.callee && other.literal === item.literal) === index),
        why: window.why.includes(why) ? window.why : (window.why ? `${why}; ${window.why}` : why),
        factKey: `${path}:verified:${hit.name}:${hit.literal}`,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return weakenUnverifiedConnectionWhy(windows, objects);
  }
}

function questionWantsAllSites(question: string): boolean {
  return /\b(all|every)\b/iu.test(question) || /所有/.test(question);
}

function hasVerifiedRegister(windows: readonly PreparedWindow[]): boolean {
  return windows.some((window) => (
    window.assessment === "verified-relation"
    && window.verifiedRelations.some((item) => item.callee === "register")
  ));
}

function hasBothConnectsEnds(windows: readonly PreparedWindow[]): boolean {
  const registerLiterals = new Set<string>();
  const requestLiterals = new Set<string>();
  for (const window of windows) {
    if (window.assessment !== "verified-relation") continue;
    for (const item of window.verifiedRelations) {
      if (item.callee === "register") registerLiterals.add(item.literal);
      if (item.callee === "request") requestLiterals.add(item.literal);
    }
  }
  for (const literal of registerLiterals) {
    if (requestLiterals.has(literal)) return true;
  }
  return false;
}

function windowIdentityKey(window: { path: string; revision: string; start: number; end: number }): string {
  return `${window.path}@${window.revision}:${window.start}-${window.end}`;
}

function windowRankKey(window: PreparedWindow): string {
  return `${window.path}:${window.start}-${window.end}`;
}

function unitSemanticRank(window: PreparedWindow): number | undefined {
  let best: number | undefined;
  for (const arrival of window.arrivals) {
    if (arrival.kind !== "semantic" || arrival.rank === undefined) continue;
    best = best === undefined ? arrival.rank : Math.min(best, arrival.rank);
  }
  return best;
}

/** Direct locate / verified relation — a partition, not a score bonus. */
function isDirectNavigationWindow(window: PreparedWindow, explicitNavigation: boolean): boolean {
  return window.assessment === "verified-relation"
    || (explicitNavigation && window.hasAnchor)
    || window.arrivals.some((arrival) => (
      arrival.kind === "graph"
      && (arrival.edgeKind === "definition" || arrival.edgeKind === "connects" || arrival.edgeKind === "references" || arrival.edgeKind === "calls")
      && arrival.arrivalReason === "object-triggered"
    ));
}

/** Unit-own lexical rank from this window's weight and distinctive coverage. */
function assignUnitLexicalRanks(windows: readonly PreparedWindow[]): Map<string, number> {
  const sorted = windows.filter((window) => (
    window.arrivals.some((arrival) => arrival.kind === "lexical")
  )).toSorted((left, right) => (
    right.windowWeight - left.windowWeight
    || Number(right.hasAnchor) - Number(left.hasAnchor)
    || right.distinctive.size - left.distinctive.size
    || comparePath(left.path, right.path)
    || left.start - right.start
  ));
  const ranks = new Map<string, number>();
  let rank = 0;
  let previousWeight: number | undefined;
  let previousAnchor: boolean | undefined;
  let previousDistinctive: number | undefined;
  sorted.forEach((window, index) => {
    if (window.windowWeight !== previousWeight || window.hasAnchor !== previousAnchor || window.distinctive.size !== previousDistinctive) {
      rank = index + 1;
      previousWeight = window.windowWeight;
      previousAnchor = window.hasAnchor;
      previousDistinctive = window.distinctive.size;
    }
    ranks.set(windowRankKey(window), rank);
  });
  return ranks;
}

function unitFusion(window: PreparedWindow, lexicalRank: number | undefined): number {
  const semantic = unitSemanticRank(window);
  return fuseFileRanks({
    ...(lexicalRank !== undefined ? { lexical: lexicalRank } : {}),
    ...(semantic !== undefined ? { semantic } : {}),
  });
}

/** Role, hit class, deduplication, and complementarity stay outside RRF (D-185). */
function isImplementationUnit(window: PreparedWindow): boolean {
  return window.unit?.kind === "function" || window.unit?.kind === "method";
}

function hitClassRank(window: PreparedWindow): number {
  return window.hitClass === "name" ? 2 : window.hitClass === "body" ? 1 : window.hitClass === "comment" ? -1 : 0;
}

/** Same-file implementation that covers a group the already-packed units of that file do not. */
function addsLocalImplementation(window: PreparedWindow, selected: PreparedWindow[]): boolean {
  if (!isImplementationUnit(window)) return false;
  const sameFile = selected.filter((item) => item.path === window.path);
  if (sameFile.length === 0) return false;
  const localImplGroups = new Set(sameFile.filter(isImplementationUnit).flatMap((item) => [...item.groups]));
  const coveredGroups = new Set(selected.flatMap((item) => [...item.groups]));
  return [...window.groups].some((groupId) => coveredGroups.has(groupId) && !localImplGroups.has(groupId));
}

function sameFileUncovered(window: PreparedWindow, selected: PreparedWindow[], weights: ReadonlyMap<string, number>): boolean {
  if (!selected.some((item) => item.path === window.path)) return false;
  const coveredGroups = new Set(selected.flatMap((item) => [...item.groups]));
  return [...window.groups].some((groupId) => !coveredGroups.has(groupId) && (weights.get(groupId) ?? 1) > 0);
}

/** A window whose assessment meets the asked object or relation. */
function carriesAskedRelation(window: PreparedWindow): boolean {
  return ASSESSMENT_RANK[window.assessment] >= ASSESSMENT_RANK["object-present"];
}

function definitionArrivalRank(window: PreparedWindow): number {
  return window.arrivals.some((item) => item.kind === "graph" && item.edgeKind === "definition") ? 1 : 0;
}

/**
 * D-148 asks for the production entry when relation evidence is comparable,
 * and a test fixture that registers the same value is comparable: both bodies
 * hold the call. A weight cannot express that — the fixture can always win on
 * weighted coverage — so it is a rank above the score, and only for a question
 * that explicitly wants production (D-157).
 */
function relationRoleRank(window: PreparedWindow, preferProduction: boolean): number {
  if (!preferProduction || !carriesAskedRelation(window)) return 0;
  return Math.max(0, window.roleFit);
}

function packComplementary(
  windows: PreparedWindow[],
  limit: number,
  weights: ReadonlyMap<string, number>,
  locatingDone: boolean,
  preferProduction: boolean,
  explicitNavigation: boolean,
): PreparedWindow[] {
  const selected: PreparedWindow[] = [];
  const remaining = locatingDone ? windows.filter((window) => !window.offTopic) : [...windows];
  const ranks = assignUnitLexicalRanks(remaining);
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    remaining.forEach((window, index) => {
      const firstPick = selected.length === 0;
      const navigation = isDirectNavigationWindow(window, explicitNavigation) ? 1 : 0;
      const role = relationRoleRank(window, preferProduction);
      const definition = firstPick ? definitionArrivalRank(window) : 0;
      const localImpl = addsLocalImplementation(window, selected) || sameFileUncovered(window, selected, weights) ? 1 : 0;
      const distinctFact = selected.some((item) => item.factKey === window.factKey) ? 0 : 1;
      const relevance = unitFusion(window, ranks.get(windowRankKey(window)));
      const hit = hitClassRank(window);
      const best = remaining[bestIndex]!;
      const bestNavigation = isDirectNavigationWindow(best, explicitNavigation) ? 1 : 0;
      const bestRole = relationRoleRank(best, preferProduction);
      const bestDefinition = firstPick ? definitionArrivalRank(best) : 0;
      const bestLocal = addsLocalImplementation(best, selected) || sameFileUncovered(best, selected, weights) ? 1 : 0;
      const bestDistinctFact = selected.some((item) => item.factKey === best.factKey) ? 0 : 1;
      const bestRelevance = unitFusion(best, ranks.get(windowRankKey(best)));
      const bestHit = hitClassRank(best);
      const better = navigation > bestNavigation
        || (navigation === bestNavigation && role > bestRole)
        || (navigation === bestNavigation && role === bestRole && definition > bestDefinition)
        || (navigation === bestNavigation && role === bestRole && definition === bestDefinition && localImpl > bestLocal)
        || (navigation === bestNavigation && role === bestRole && definition === bestDefinition && localImpl === bestLocal && distinctFact > bestDistinctFact)
        || (navigation === bestNavigation && role === bestRole && definition === bestDefinition && localImpl === bestLocal && distinctFact === bestDistinctFact && relevance > bestRelevance)
        || (navigation === bestNavigation && role === bestRole && definition === bestDefinition && localImpl === bestLocal && distinctFact === bestDistinctFact && relevance === bestRelevance && hit > bestHit)
        || (navigation === bestNavigation && role === bestRole && definition === bestDefinition && localImpl === bestLocal && distinctFact === bestDistinctFact && relevance === bestRelevance && hit === bestHit
          && (comparePath(window.path, best.path) < 0 || (window.path === best.path && window.start < best.start)));
      if (better) {
        bestIndex = index;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function snippetFrom(window: PreparedWindow): ExploreSnippet {
  return {
    path: window.path,
    startLine: window.start,
    endLine: window.end,
    text: window.text,
    why: window.why,
    revision: window.revision,
    source: window.source,
    ...(window.unit ? { unit: window.unit } : {}),
    ...(window.structure ? { structure: window.structure } : {}),
  };
}

async function outlineForSnapshot(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  deps: ExploreDeps,
  signal: AbortSignal,
  hitLines: number[],
): Promise<StructureOutlineResult | { status: "not-requested"; provider: null }> {
  if (!deps.structure) return { status: "not-requested", provider: null };
  try {
    signal.throwIfAborted();
    const result = await deps.structure.outline({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      signal,
      hitLines,
    });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      status: "failed",
      provider: null,
      revision: snapshot.revision,
      symbols: [],
      message: error instanceof Error ? error.message : "Structure source failed.",
    };
  }
}

function collectPatterns(groups: TermGroup[]): Map<string, Array<{ group: TermGroup; distinctive: boolean }>> {
  const patternOwners = new Map<string, Array<{ group: TermGroup; distinctive: boolean }>>();
  for (const group of groups) {
    for (const variant of searchVariantsOf(group)) {
      const owners = patternOwners.get(variant) ?? [];
      owners.push({ group, distinctive: variant === group.distinctive });
      patternOwners.set(variant, owners);
    }
  }
  return patternOwners;
}

export type ExploreQueryTerminal = "active" | "finished" | "cancelled";

export interface ExploreQueryRunOptions {
  signal?: AbortSignal;
  /** Shared abort for this query's sources. Prefer this over a second internal controller. */
  controller?: AbortController;
  deadlineAt?: number;
  reserveForJudgeMs?: number;
  now?: () => number;
}

export interface ExploreQueryRun {
  start(): void;
  submitPlan(plan: ExploreGroupedSearchPlan): Promise<{ launched: string[]; reused: string[] }>;
  waitForViews(): Promise<void>;
  /** Wake a progressive consumer when a later plan/follow-up adds work. */
  waitForProgress(): Promise<void>;
  viewsForModel(byteBudget?: number): {
    views: ExploreQueryView[];
    unevaluated: number;
    hypotheses?: { behavior?: string; expectedMaterials?: string[] };
  };
  applySelection(groups: readonly ExploreQuerySelectionGroup[], options?: { merge?: boolean }): ExploreQuerySelectResult;
  applyRerank(scores: readonly ExploreRerankScore[], details: ExploreRerankDetails): void;
  refreshVocab(): Promise<void>;
  followup(request: Omit<ExploreQueryFollowupParams, "queryId">): Promise<{
    launched: string[];
    reused: string[];
    newViews: ExploreQueryView[];
    actionsExecuted: string[];
    actionsRejected: Array<{ actionId: string; reason: string }>;
  }>;
  /**
   * Real next-step candidates generated from material this query already
   * produced (D-312). The fast-decision caller offers these ids to the model;
   * `followup({actions})` executes the chosen ones.
   */
  actionCandidates(): Promise<ExploreQueryAction[]>;
  /** Record the fast-decision loop's provenance for `finish` (D-312). */
  applyFastDecision(details: ExploreFastDecisionDetails): void;
  finish(model?: ExploreModelParticipation): ExploreResult;
  cancel(): void;
  readonly parsed: ExploreQueryParse;
  readonly deadlineAt: number;
  readonly question: string;
  readonly signal: AbortSignal;
  terminal(): ExploreQueryTerminal;
  sourceStates(): ExploreQuerySourceState[];
  vocab(): ExploreQueryVocab;
}

/**
 * Deterministic retrieval only. Models and credentials belong to the pi-host coordinator.
 * Every emitted excerpt comes from a successfully read, versioned Document snapshot.
 */
export function createExploreQueryRun(
  input: ExploreInput,
  deps: ExploreDeps,
  options: ExploreQueryRunOptions = {},
): ExploreQueryRun {
  const startedAt = options.now?.() ?? Date.now();
  const now = options.now ?? Date.now;
  const controller = options.controller ?? new AbortController();
  if (options.signal) {
    if (options.signal.aborted) {
      if (!controller.signal.aborted) controller.abort();
    } else {
      options.signal.addEventListener("abort", () => {
        if (!controller.signal.aborted) controller.abort();
      }, { once: true });
    }
  }
  const signal = controller.signal;
  let terminal: ExploreQueryTerminal = "active";
  const terminalState = (): ExploreQueryTerminal => terminal;
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const reserveForJudgeMs = options.reserveForJudgeMs ?? 0;
  signal.throwIfAborted();
  const excerptLimit = input.limit ?? DEFAULT_EXCERPT_LIMIT;
  const parsed = parseExploreQuery(input.question, input.anchors ?? []);
  const groups = parsed.groups;
  const { suppliedAnchors, usedAnchors, anchorsTruncated } = parsed;
  const objectPatterns = collectPatterns(objectGroupsOf(groups));
  const contentPatterns = collectPatterns(contentGroupsOf(groups));
  if (objectPatterns.size === 0 && contentPatterns.size === 0 && input.question.trim()) {
    const fallback: TermGroup = { id: "question:raw", kind: "question", distinctive: input.question.trim(), variants: [input.question.trim()] };
    groups.push(fallback);
    contentPatterns.set(fallback.distinctive, [{ group: fallback, distinctive: true }]);
  }

  const byFile = new Map<string, FileEvidence>();
  let searchIncomplete = false;
  let filesDropped = 0;
  let launchedPatterns = 0;
  const skippedContent: string[] = [];
  const launchedCoverage = new Map<string, PatternCoverage>();
  const rankNow = (): RankedCandidate[] => rankCandidates(
    byFile,
    groups,
    parsed,
    buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf),
  );

  type SettledProductionStatus = Extract<
    ExploreQuerySourceState["status"],
    "ready" | "empty" | "unavailable" | "failed" | "incomplete"
  >;
  type ProductionTask = {
    id: string;
    family: ExploreQuerySourceState["family"];
    primary: boolean;
    status: ExploreQuerySourceState["status"];
    promise: Promise<void>;
  };
  const tasks = new Map<string, ProductionTask>();
  let fatalError: unknown;
  const launchedExpressions = new Set<string>();
  /**
   * Follow-up action bookkeeping (D-312): candidates the Host issued to the
   * decision model, which the model selected and the query executed, and which
   * graph lookups already ran so a candidate never duplicates a launched task.
   */
  const issuedActions = new Map<string, ExploreQueryAction>();
  const executedActions = new Set<string>();
  const linksRequested = new Set<string>();
  const importersRequested = new Set<string>();
  const relationLookupsRequested = new Set<string>();
  const symbolsSearched = new Set<string>();
  let fastDecisionDetails: ExploreFastDecisionDetails | undefined;
  let catalogVocab: ExploreQueryVocab["catalog"];
  let catalogPackages: string[] | undefined;
  let catalogEntries: string[] | undefined;
  let planHypotheses: { behavior?: string; expectedMaterials?: string[] } | undefined;
  let frozenViews: ExploreQueryView[] = [];
  let unevaluatedViewCount = 0;
  type ChosenGroup = { id: string; purpose: string; windows: PreparedWindow[]; requiredFlags: boolean[] };
  let chosenGroups: ChosenGroup[] = [];
  let rerankDetails: ExploreRerankDetails | undefined;
  let selectionGaps: string[] = [];
  const uniqueGaps = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  let viewsFrozen = false;
  let frozenResult: ExploreResult | undefined;
  const viewIdsByIdentity = new Map<string, string>();
  let nextViewSerial = 1;
  const explicitNavigation = exploreIsExplicitNavigation(input.question, parsed.objects);

  const applyCatalogVocab = (stats: { symbolCount: number; fileCount?: number; paths?: string[] }): void => {
    const scopedPaths = stats.paths?.filter((path) => pathInRoots(path, input.paths));
    const built = vocabFromCatalog({ ...stats, ...(scopedPaths ? { paths: scopedPaths } : {}) });
    // Whole-workspace counts are not scoped facts. A restricted query can still
    // use package/entry vocabulary derived from paths inside its fixed scope.
    catalogVocab = input.paths?.length ? undefined : built.catalog;
    catalogPackages = built.packages;
    catalogEntries = built.entries;
  };

  const refreshVocab = async (): Promise<void> => {
    if (!deps.graph || catalogVocab) return;
    try {
      signal.throwIfAborted();
      const stats = await deps.graph.catalogStats();
      signal.throwIfAborted();
      applyCatalogVocab(stats);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Vocab is advisory; a closed or failed catalog does not fail the query.
    }
  };

  const stableViewId = (window: PreparedWindow): string => {
    const key = windowIdentityKey(window);
    const existing = viewIdsByIdentity.get(key);
    if (existing) return existing;
    const id = `v${nextViewSerial}`;
    nextViewSerial += 1;
    viewIdsByIdentity.set(key, id);
    return id;
  };

  const viewLogicalKey = (view: Pick<ExploreQueryView, "path" | "revision" | "startLine" | "endLine">): string => (
    `${view.path}@${view.revision}:${view.startLine}-${view.endLine}`
  );

  const remainingMs = (): number => deadlineAt - now() - reserveForJudgeMs;

  const launchTask = (
    id: string,
    family: ProductionTask["family"],
    primary: boolean,
    work: () => Promise<SettledProductionStatus | void>,
  ): void => {
    if (tasks.has(id)) return;
    const task: ProductionTask = { id, family, primary, status: "running", promise: Promise.resolve() };
    task.promise = (async () => {
      try {
        if (terminal !== "active") {
          task.status = "cancelled";
          return;
        }
        const outcome = await work();
        if (task.status === "incomplete") return;
        if (terminal !== "active") {
          task.status = terminal === "cancelled" ? "cancelled" : "incomplete";
          return;
        }
        task.status = outcome ?? "ready";
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (task.status === "running" || task.status === "pending") {
            task.status = terminal === "cancelled" ? "cancelled" : "incomplete";
          }
          return;
        }
        const code = error && typeof error === "object" && "harnessCode" in error
          ? (error as { harnessCode?: unknown }).harnessCode
          : error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        task.status = code === "unavailable" ? "unavailable" : "failed";
        fatalError ??= error;
      }
    })();
    tasks.set(id, task);
  };

  const primaryInflight = (): ProductionTask[] => [...tasks.values()].filter((task) => (
    task.primary && (task.status === "running" || task.status === "pending")
  ));

  const runRg = async (patterns: Map<string, Array<{ group: TermGroup; distinctive: boolean }>>): Promise<SettledProductionStatus> => {
    if (terminal !== "active") return "incomplete";
    launchedPatterns += patterns.size;
    let hitCount = 0;
    for (const pattern of patterns.keys()) launchedExpressions.add(pattern);
    await Promise.all([...patterns.entries()].map(async ([pattern, owners]) => {
      signal.throwIfAborted();
      const anchorOwned = owners.some((owner) => owner.group.kind === "anchor");
      const result = normalizeRgResult(await deps.rgSearch(pattern, {
        fixedStrings: true,
        ...(input.paths ? { paths: input.paths } : {}),
        candidateBudget: anchorOwned ? DEFAULT_ANCHOR_BUDGET : DEFAULT_CANDIDATE_BUDGET,
        hitsPerFile: DEFAULT_HITS_PER_FILE,
      }));
      signal.throwIfAborted();
      if (result.partial || result.filesDropped > 0) searchIncomplete = true;
      hitCount += result.hits.length;
      filesDropped = Math.max(filesDropped, result.filesDropped);
      const previous = launchedCoverage.get(pattern);
      launchedCoverage.set(pattern, {
        coverage: previous
          ? (previous.coverage === "lower-bound" || result.fileCoverage === "lower-bound"
            ? "lower-bound"
            : previous.coverage === "unknown" || result.fileCoverage === "unknown"
              ? "unknown"
              : "complete")
          : result.fileCoverage,
        filesDropped: Math.max(previous?.filesDropped ?? 0, result.filesDropped),
      });
      for (const hit of result.hits) {
        for (const owner of owners) recordHit(byFile, hit, owner.group, owner.distinctive);
      }
    }));
    return hitCount > 0 ? "ready" : "empty";
  };

  for (const object of parsed.objects) {
    if (!looksLikePathObject(object) || !pathInRoots(object, input.paths)) continue;
    if (!byFile.has(object)) byFile.set(object, emptyEvidence());
  }

  let semanticReport: ExploreSemanticDetails = {
    status: deps.semantic ? "unavailable" : "not-requested",
    coverage: "empty",
    index: { lifecycle: "idle" },
  };
  let semanticBlocks = 0;

  let graphStatus: ExploreGraphStatus = deps.graph ? "unavailable" : "not-requested";
  const definitionFiles = new Set<string>();
  const connectionFiles = new Set<string>();
  const associateFiles = new Set<string>();
  const importFiles = new Set<string>();
  const relationFiles = new Set<string>();
  let graphFilesDropped = 0;
  let graphPartial = false;

  const runGraphSeeds = async (): Promise<SettledProductionStatus> => {
    if (!deps.graph) return "unavailable";
    const before = definitionFiles.size + connectionFiles.size + associateFiles.size + relationFiles.size;
    try {
      const stats = await deps.graph.catalogStats();
      signal.throwIfAborted();
      applyCatalogVocab(stats);
      if (stats.symbolCount === 0) {
        graphStatus = "empty";
        return "empty";
      }
      graphStatus = "ready";
      const seenDefinitions = new Set<string>();
      const droppedDefinitions = new Set<string>();
      let newDefinitionPaths = 0;
      const acceptDefinition = (path: string): boolean => {
        if (seenDefinitions.has(path)) return true;
        if (!byFile.has(path)) {
          if (newDefinitionPaths >= DEFAULT_GRAPH_DEFINITION_BUDGET) return false;
          newDefinitionPaths += 1;
        }
        seenDefinitions.add(path);
        return true;
      };
      for (const object of parsed.objects) {
        if (!looksLikeSymbolName(object)) continue;
        signal.throwIfAborted();
        symbolsSearched.add(object);
        const hits = await deps.graph.searchDefinitions(object, DEFAULT_GRAPH_DEFINITIONS_PER_TERM);
        signal.throwIfAborted();
        for (const hit of hits) {
          if (hit.match === "path-contains" || !pathInRoots(hit.path, input.paths)) continue;
          if (!acceptDefinition(hit.path)) {
            droppedDefinitions.add(hit.path);
            continue;
          }
          const evidence = byFile.get(hit.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "definition",
            why: `definition of ${hit.name} (${hit.kind})`,
            locate: { text: hit.name, kind: "identifier" },
            arrivalReason: "object-triggered",
            match: hit.match === "exact" ? "exact" : "name-contains",
          });
          byFile.set(hit.path, evidence);
          definitionFiles.add(hit.path);
        }
      }
      if (droppedDefinitions.size > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, droppedDefinitions.size);
        graphPartial = true;
      }
      let connectionDropped = 0;
      for (const object of parsed.objects) {
        if (!looksLikeConnectionValue(object)) continue;
        signal.throwIfAborted();
        linksRequested.add(object);
        const ends = await deps.graph.findLinks(object);
        signal.throwIfAborted();
        for (const end of ends) {
          if (!pathInRoots(end.path, input.paths)) continue;
          const connects = end.kind === "connects";
          if (!connects && end.kind !== "associates") continue;
          const alreadyReadHint = byFile.has(end.path);
          if (!alreadyReadHint && connects && connectionFiles.size >= DEFAULT_GRAPH_CONNECTION_BUDGET) {
            connectionDropped += 1;
            continue;
          }
          const evidence = byFile.get(end.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: connects ? "connection" : "association",
            why: connects
              ? `other end of connection "${object}"`
              : `associated mention of "${object}"`,
            locate: { text: object, kind: "literal" },
            arrivalReason: "object-triggered",
            edgeKind: connects ? "connects" : "associates",
            ...(end.callee ? { callee: end.callee } : {}),
          });
          byFile.set(end.path, evidence);
          if (connects) connectionFiles.add(end.path);
          else associateFiles.add(end.path);
        }
      }
      if (connectionDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, connectionDropped);
        graphPartial = true;
      }
      // Resolved relation edges around the question's symbols (D-240): files
      // holding a real reference or call site for an object are graph
      // candidates like definitions and connection endpoints — bounded so a
      // hot symbol cannot flood the pool.
      let relationDropped = 0;
      for (const object of parsed.objects) {
        if (!looksLikeSymbolName(object)) continue;
        signal.throwIfAborted();
        relationLookupsRequested.add(`callers:${object}`);
        relationLookupsRequested.add(`references:${object}`);
        const [callers, references] = await Promise.all([
          deps.graph.findCallers ? deps.graph.findCallers(object) : Promise.resolve([]),
          deps.graph.findReferences ? deps.graph.findReferences(object) : Promise.resolve([]),
        ]);
        signal.throwIfAborted();
        for (const site of [
          ...callers.map((entry) => ({ ...entry, edge: "calls" as const })),
          ...references.map((entry) => ({ ...entry, edge: "references" as const })),
        ]) {
          if (!pathInRoots(site.path, input.paths)) continue;
          if (!byFile.has(site.path) && relationFiles.size >= DEFAULT_GRAPH_RELATION_BUDGET) {
            relationDropped += 1;
            continue;
          }
          const evidence = byFile.get(site.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: site.edge,
            why: site.edge === "calls" ? `calls ${object}` : `references ${object}`,
            locate: { text: object, kind: "identifier" },
            arrivalReason: "object-triggered",
            edgeKind: site.edge,
          });
          byFile.set(site.path, evidence);
          relationFiles.add(site.path);
        }
      }
      if (relationDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, relationDropped);
        graphPartial = true;
      }
      return definitionFiles.size + connectionFiles.size + associateFiles.size + relationFiles.size > before ? "ready" : "empty";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      graphStatus = code === "unavailable" ? "unavailable" : "failed";
      return graphStatus === "unavailable" ? "unavailable" : "failed";
    }
  };

  const ingestSemanticHits = (result: ExploreSemanticSearch): void => {
    semanticReport = {
      status: result.status,
      coverage: result.coverage,
      ...(result.note ? { note: result.note } : {}),
      ...(result.generation ? { generation: result.generation } : {}),
      ...(result.spaceId ? { spaceId: result.spaceId } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      index: { lifecycle: result.lifecycle },
      blocks: (semanticReport.blocks ?? 0) + result.hits.length,
      ...(result.gaps?.length ? { gaps: [...(semanticReport.gaps ?? []), ...result.gaps] } : {}),
    };
    if (result.status === "unavailable" || result.status === "failed" || result.status === "stale") return;
    for (const hit of result.hits) {
      if (!pathInRoots(hit.documentId, input.paths)) continue;
      const evidence = byFile.get(hit.documentId) ?? emptyEvidence();
      if (!evidence.semanticClues.some((clue) => clue.blockId === hit.blockId)) {
        evidence.semanticClues.push({
          blockId: hit.blockId,
          parentUnitId: hit.parentUnitId,
          parentName: hit.parentName,
          parentKind: hit.parentKind,
          startLine: hit.startLine,
          endLine: hit.endLine,
          contentHash: hit.contentHash,
          body: hit.body,
          similarity: hit.similarity,
          rank: hit.rank,
        });
        semanticBlocks += 1;
      }
      byFile.set(hit.documentId, evidence);
    }
    if (semanticBlocks === 0 && result.status === "ready") semanticReport.status = "empty";
    else if (semanticBlocks > 0 && semanticReport.status === "empty") semanticReport.status = "ready";
  };

  const semanticTaskStatus = (status: ExploreSemanticStatus): SettledProductionStatus => {
    if (status === "ready") return "ready";
    if (status === "empty" || status === "not-requested") return "empty";
    if (status === "incomplete") return "incomplete";
    if (status === "unavailable" || status === "stale") return "unavailable";
    return "failed";
  };

  const combineProductionStatuses = (statuses: readonly SettledProductionStatus[]): SettledProductionStatus => {
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("incomplete")) return "incomplete";
    if (statuses.includes("ready")) return "ready";
    if (statuses.includes("empty")) return "empty";
    return "unavailable";
  };

  const runSemanticQuery = async (question: string): Promise<SettledProductionStatus> => {
    if (!deps.semantic) return "unavailable";
    signal.throwIfAborted();
    try {
      const result = await deps.semantic.search(question, DEFAULT_SEMANTIC_RECALL, signal);
      signal.throwIfAborted();
      if (!result || typeof result !== "object" || !("hits" in result) || !Array.isArray(result.hits)) {
        semanticReport = { ...semanticReport, status: "failed" };
        return "failed";
      }
      const blocksBefore = semanticBlocks;
      ingestSemanticHits(result);
      if (result.status === "ready" && semanticBlocks === blocksBefore) return "empty";
      return semanticTaskStatus(result.status);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      semanticReport = { ...semanticReport, status: "failed" };
      return "failed";
    }
  };

  const runSemanticQueries = async (questions: readonly string[]): Promise<SettledProductionStatus> => {
    const statuses: SettledProductionStatus[] = [];
    for (const question of questions) {
      if (!question.trim()) continue;
      statuses.push(await runSemanticQuery(question));
    }
    return statuses.length > 0 ? combineProductionStatuses(statuses) : "empty";
  };

  const runSemantic = async (): Promise<SettledProductionStatus> => runSemanticQuery(input.question);

  const issues: ExploreIssue[] = [];
  const provenance = new Map<string, ExploreProvenance>();
  const structureFiles = new Map<string, NonNullable<WireResult["details"]["structure"]>["files"][number]>();
  const prepared: PreparedWindow[] = [];
  const snapshots = new Map<string, ExploreFileSnapshot>();
  const readPaths = new Set<string>();
  /** Evidence signature each read path's windows were last built against. */
  const windowedEvidence = new Map<string, string>();
  let reads = 0;

  const replacePrepared = (path: string, windows: readonly PreparedWindow[]): void => {
    const kept = prepared.filter((window) => window.path !== path);
    prepared.splice(0, prepared.length, ...kept, ...windows);
  };

  const markProvenance = (path: string, status: ExploreProvenance["status"], snapshot?: ExploreFileSnapshot): void => {
    const evidence = byFile.get(path);
    const ready = snapshot && snapshot.status === "ready" ? snapshot : undefined;
    provenance.set(path, {
      path,
      revision: ready?.revision ?? "",
      source: ready?.source ?? null,
      status,
      matchedGroups: evidence ? [...evidence.groups] : [],
    });
  };

  const materializeBatch = async (batch: readonly RankedCandidate[]): Promise<void> => {
    const snapshotsNeeded = await Promise.all(batch.map(async (candidate) => {
      signal.throwIfAborted();
      const cached = snapshots.get(candidate.path);
      if (cached) return [candidate, cached] as const;
      try {
        const snapshot = await deps.readFile(candidate.path);
        snapshots.set(candidate.path, snapshot);
        return [candidate, snapshot] as const;
      } catch {
        signal.throwIfAborted();
        const failed = { status: "failed" as const, message: "Document read failed. Search again or inspect workspace availability." };
        snapshots.set(candidate.path, failed);
        return [candidate, failed] as const;
      }
    }));
    signal.throwIfAborted();
    for (const [candidate, snapshot] of snapshotsNeeded) {
      readPaths.add(candidate.path);
      if (snapshot.status !== "ready") {
        issues.push({ path: candidate.path, status: snapshot.status, message: snapshot.message });
        markProvenance(candidate.path, snapshot.status, snapshot);
        continue;
      }
      await buildWindowsFrom(candidate.path, snapshot, candidate.evidence);
    }
  };

  /**
   * Turn one already-acquired snapshot into windows against the evidence this
   * file carries *now*. Safe to run again on the same snapshot: the snapshot
   * cache means no disk read, and the structure providers key their parse cache
   * on the content hash, so a second pass over the same text is a cache hit.
   */
  const buildWindowsFrom = async (
    path: string,
    snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
    evidence: FileEvidence,
  ): Promise<void> => {
    const lines = snapshot.content.split(/\r\n|\n|\r/);
    applyGraphLocate(lines, evidence);
    for (const object of parsed.objects) {
      if (!looksLikePathObject(path) && path !== object) continue;
      for (const line of locateLiteralLines(lines, object)) {
        if (evidence.hits.has(line)) continue;
        evidence.hits.set(line, {
          text: lines[line - 1]!,
          groups: new Set(),
          distinctive: new Set(),
          clues: [],
        });
      }
    }
    rescanBodyGroups(lines, groups, evidence);
    // Remember the evidence this build actually consumed. A source can arrive
    // while outline/classification awaits; recording the later mutable object
    // would falsely claim those late clues were already materialized.
    const consumedEvidence = evidenceSignature(evidence);
    const hitLines = [
      ...evidence.hits.keys(),
      ...evidence.semanticClues.map((clue) => clue.startLine),
    ].filter((line) => Number.isSafeInteger(line) && line >= 1);
    const outline = await outlineForSnapshot(path, snapshot, deps, signal, hitLines);
    if (outline.status !== "not-requested") {
      structureFiles.set(path, {
        path,
        provider: outline.provider,
        status: outline.status === "ready" && outline.revision !== snapshot.revision ? "stale" : outline.status,
      });
    }
    const weights = weightByGroupId(groups, buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf));
    const sliced = windowsFor(path, lines, evidence, snapshot, groups, outline, parsed, weights);
    const classified = await classifyPreparedWindows(path, snapshot, sliced.windows, deps, signal);
    const windows = await verifyMaterializedRelations(path, snapshot, evidence, classified, parsed, deps, signal);
    if (sliced.stale && !issues.some((issue) => issue.path === path && issue.status === "stale")) {
      issues.push({
        path,
        status: "stale",
        message: "Some search hits no longer match this document revision; those hits were omitted.",
      });
    }
    replacePrepared(path, windows);
    if (windows.length === 0) {
      markProvenance(path, sliced.stale ? "stale" : "empty", snapshot);
      windowedEvidence.set(path, consumedEvidence);
      return;
    }
    markProvenance(path, "ready", snapshot);
    windowedEvidence.set(path, consumedEvidence);
  };

  /**
   * New hits arriving after a file was read do not reach the model unless its
   * windows are rebuilt: the object pass freezes a window around the object
   * mention, and the later content-word pass skips the file because it is
   * already read. Reuse the snapshot and recompute (D-152).
   */
  const refreshReadEvidence = async (): Promise<void> => {
    for (const path of readPaths) {
      signal.throwIfAborted();
      const snapshot = snapshots.get(path);
      if (!snapshot || snapshot.status !== "ready") continue;
      const evidence = byFile.get(path);
      if (!evidence) continue;
      if (windowedEvidence.get(path) === evidenceSignature(evidence)) continue;
      await buildWindowsFrom(path, snapshot, evidence);
    }
  };

  const locating = parsed.relation === "register" && parsed.objects.some((object) => looksLikeConnectionValue(object));
  const wantsBothEnds = parsed.relation === "unknown" && parsed.objects.some((object) => looksLikeConnectionValue(object));
  const allSites = questionWantsAllSites(input.question);

  const shouldStop = (scheduled: readonly RankedCandidate[], next: number, budget: number): boolean => {
    if (next >= scheduled.length || reads >= budget) return true;
    if (!allSites && locating && hasVerifiedRegister(prepared)) return true;
    if (!allSites && wantsBothEnds && hasBothConnectsEnds(prepared)) return true;
    // `limit` is an output cap, not a reason to stop reading. Locating
    // and both-ends questions already returned above. How-questions use
    // the remaining read budget.
    return false;
  };

  const materializeScheduled = async (scheduled: RankedCandidate[], budget: number): Promise<void> => {
    let next = 0;
    while (next < scheduled.length && reads < budget) {
      if (shouldStop(scheduled, next, budget)) break;
      const batch: RankedCandidate[] = [];
      while (next < scheduled.length && batch.length < DEFAULT_READ_PARALLELISM && reads + batch.length < budget) {
        const candidate = scheduled[next]!;
        next += 1;
        if (readPaths.has(candidate.path)) continue;
        batch.push(candidate);
      }
      if (batch.length === 0) continue;
      reads += batch.length;
      await materializeBatch(batch);
    }
  };

  const materializeAvailable = async (): Promise<void> => {
    if (terminal !== "active") return;
    const rankedNow = rankNow();
    const scheduledNow = scheduleReads(rankedNow, groups, parsed);
    const reserved = primaryInflight().length * DEFAULT_READ_PARALLELISM;
    const budget = maxMaterializeReads(scheduledNow.length, excerptLimit);
    const spendable = Math.max(DEFAULT_READ_PARALLELISM, Math.max(0, budget - reserved));
    await materializeScheduled(scheduledNow, Math.min(budget, reads + spendable));
  };

  const markInflightIncomplete = (): boolean => {
    let stopped = false;
    for (const task of tasks.values()) {
      if (task.status === "running" || task.status === "pending") {
        task.status = "incomplete";
        stopped = true;
      }
    }
    if (stopped) searchIncomplete = true;
    const semanticTask = [...tasks.values()].find((task) => task.family === "semantic");
    if (semanticTask && (semanticTask.status === "incomplete" || semanticTask.status === "cancelled")) {
      if (semanticReport.status === "unavailable" || semanticReport.status === "not-requested") {
        semanticReport = { ...semanticReport, status: "incomplete" };
      }
    }
    return stopped;
  };

  let deadlineStopped = false;
  const abortLeftoverSources = (): void => {
    markInflightIncomplete();
    if (!controller.signal.aborted) controller.abort();
  };

  const pumpUntilPrimarySettled = async (): Promise<void> => {
    while (terminal === "active") {
      if (remainingMs() <= 0) {
        deadlineStopped = true;
        abortLeftoverSources();
        break;
      }
      if (byFile.size > 0) await materializeAvailable();
      const inflight = primaryInflight();
      if (inflight.length === 0) break;
      await Promise.race([
        ...inflight.map((task) => task.promise.catch(() => undefined)),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(20, Math.max(1, remainingMs())));
        }),
      ]);
    }
    if (terminal === "active" && !signal.aborted) {
      await refreshReadEvidence();
      await materializeAvailable();
    }
  };

  let pumpPromise: Promise<void> | undefined;
  /** Serializes `waitForViews` driving passes across concurrent callers. */
  let viewsTurn: Promise<void> = Promise.resolve();
  const progressWaiters = new Set<() => void>();
  const notifyProgress = (): void => {
    for (const resolve of progressWaiters) resolve();
    progressWaiters.clear();
  };
  const waitForProgress = (): Promise<void> => {
    if (terminal !== "active" || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => { progressWaiters.add(resolve); });
  };
  const pumpErrors: unknown[] = [];
  const ensurePump = (): Promise<void> => {
    if (pumpPromise) return pumpPromise;
    const running = pumpUntilPrimarySettled()
      .catch((error) => { pumpErrors.push(error); })
      .finally(() => { pumpPromise = undefined; });
    pumpPromise = running;
    return running;
  };
  const kickPump = (): void => {
    void ensurePump().then(() => {
      if (pumpErrors.length === 0 && terminal === "active" && !signal.aborted && primaryInflight().length > 0) kickPump();
    });
  };
  const awaitPump = async (): Promise<void> => {
    do {
      await ensurePump();
      const error = pumpErrors.shift();
      if (error !== undefined) throw error;
    } while (pumpErrors.length === 0 && terminal === "active" && !signal.aborted && primaryInflight().length > 0);
  };

  const toView = (viewId: string, window: PreparedWindow): ExploreQueryView => {
    const ranges = [
      { rangeId: `${viewId}:full`, startLine: window.start, endLine: window.end },
      ...window.hitLines
        .filter((line, index, list) => list.indexOf(line) === index)
        .map((line, index) => ({ rangeId: `${viewId}:h${index + 1}`, startLine: line, endLine: line })),
    ];
    return {
      viewId,
      path: window.path,
      startLine: window.start,
      endLine: window.end,
      text: window.text,
      revision: window.revision,
      source: window.source,
      ranges,
      arrivals: window.arrivals,
      assessment: window.assessment,
      purpose: window.purpose,
      why: window.why,
      ...(window.unit ? { unit: window.unit } : {}),
    };
  };

  const freezeViews = (byteBudget = DEFAULT_MODEL_INPUT_BYTES): void => {
    const unique: PreparedWindow[] = [];
    const seen = new Set<string>();
    for (const window of prepared) {
      const key = windowIdentityKey(window);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(window);
    }
    const ranks = assignUnitLexicalRanks(unique);
    unique.sort((left, right) => {
      const navigation = Number(isDirectNavigationWindow(right, explicitNavigation)) - Number(isDirectNavigationWindow(left, explicitNavigation));
      if (navigation !== 0) return navigation;
      const fused = unitFusion(right, ranks.get(windowRankKey(right))) - unitFusion(left, ranks.get(windowRankKey(left)));
      if (fused !== 0) return fused;
      const hit = hitClassRank(right) - hitClassRank(left);
      if (hit !== 0) return hit;
      return comparePath(left.path, right.path) || left.start - right.start;
    });
    frozenViews = [];
    unevaluatedViewCount = 0;
    let used = 0;
    for (const window of unique) {
      const view = toView(stableViewId(window), window);
      const size = utf8Bytes(view.text) + 96;
      if (used + size <= byteBudget) {
        used += size;
        frozenViews.push(view);
      } else {
        unevaluatedViewCount += 1;
      }
    }
    viewsFrozen = true;
  };

  const start = (): void => {
    if (terminal !== "active") return;
    if (tasks.has("lexical-original") || tasks.has("lexical-content")) return;
    if (objectPatterns.size > 0) {
      launchTask("lexical-original", "lexical", true, () => runRg(objectPatterns));
    }
    if (contentPatterns.size > 0 && !explicitNavigation && !locating && !wantsBothEnds) {
      launchTask("lexical-content", "lexical", true, () => runRg(contentPatterns));
    }
    if (deps.graph) launchTask("graph-seeds", "graph", true, runGraphSeeds);
    if (deps.semantic) launchTask("semantic-original", "semantic", true, runSemantic);
    kickPump();
  };

  const waitForViews = async (): Promise<void> => {
    // Both the caller's views service and the fast-decision loop wait on the
    // same pipeline; serialize the driving pass so a second caller cannot
    // double-run the content search / materialize stages below.
    const turn = viewsTurn.then(() => driveViews());
    viewsTurn = turn.catch(() => undefined);
    return turn;
  };

  const driveViews = async (): Promise<void> => {
    if (terminal !== "active") return;
    start();
    try {
      await awaitPump();
      if (terminal !== "active") return;
      if (fatalError && byFile.size === 0) throw fatalError;
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
      if (!deadlineStopped || terminalState() === "cancelled" || options.signal?.aborted) throw error;
      if (terminal !== "active") return;
    }
    if (fatalError && byFile.size === 0) throw fatalError;
    if (options.signal?.aborted || terminalState() === "cancelled") {
      const error = new Error("Explore query cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (signal.aborted || remainingMs() <= 0) {
      freezeViews();
      return;
    }
    let ranked = rankNow();
    let scheduled = scheduleReads(ranked, groups, parsed);

  const verifiedEnough = (!allSites && locating && hasVerifiedRegister(prepared))
    || (!allSites && wantsBothEnds && hasBothConnectsEnds(prepared));
  if (verifiedEnough && !tasks.has("lexical-content")) {
    skippedContent.push(...contentPatterns.keys());
  } else if (contentPatterns.size > 0 && !tasks.has("lexical-content") && !explicitNavigation) {
    await runRg(contentPatterns);
    // Check the content words against text already in hand before spending a
    // read on a new file: the answer may be in a file the object pass read.
    await refreshReadEvidence();
    ranked = rankNow();
    scheduled = scheduleReads(ranked, groups, parsed);
    await materializeScheduled(scheduled, maxMaterializeReads(scheduled.length, excerptLimit));
  }

  if (deps.graph && (graphStatus as ExploreGraphStatus) === "ready") {
    try {
      const seedPaths = [...readPaths];
      const connectionPaths: string[] = [];
      const importPaths: string[] = [];
      const seenNew = new Set<string>();
      const literals = new Set<string>();
      for (const object of parsed.objects) {
        if (looksLikeConnectionValue(object)) literals.add(object);
      }
      for (const window of prepared) {
        signal.throwIfAborted();
        const relations = await deps.graph.fileRelations(window.path);
        signal.throwIfAborted();
        if (!relations) continue;
        for (const conn of relations.connections) {
          if (window.text.includes(conn.literal)) literals.add(conn.literal);
        }
      }
      // A window that is a registration table holds every literal it registers,
      // so spend the wire budget on the question's own object first and let the
      // rest in only at support grade (D-151).
      const locatingDone = !allSites && locating && hasVerifiedRegister(prepared);
      const bothEndsDone = !allSites && wantsBothEnds && hasBothConnectsEnds(prepared);
      const ordered = [...literals].sort((left, right) => (
        Number(literalOffTopic(left, parsed)) - Number(literalOffTopic(right, parsed))
      ));
      let connectionDropped = 0;
      for (const literal of ordered) {
        signal.throwIfAborted();
        const offTopic = literalOffTopic(literal, parsed);
        if ((locatingDone || bothEndsDone) && offTopic) continue;
        const arrivalReason = arrivalForLiteral(literal, parsed, prepared);
        linksRequested.add(literal);
        const ends = await deps.graph.findLinks(literal);
        signal.throwIfAborted();
        for (const end of ends) {
          if (!pathInRoots(end.path, input.paths)) continue;
          const connects = end.kind === "connects";
          const alreadyRead = readPaths.has(end.path);
          const extraRead = isDirectArrival(arrivalReason);
          if (!alreadyRead && extraRead && connectionPaths.length >= DEFAULT_GRAPH_CONNECTION_BUDGET) {
            connectionDropped += 1;
            continue;
          }
          const evidence = byFile.get(end.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: connects ? "connection" : "association",
            why: connects
              ? `other end of connection "${literal}"`
              : `associated mention of "${literal}"`,
            locate: { text: literal, kind: "literal" },
            arrivalReason,
            edgeKind: connects ? "connects" : "associates",
            ...(end.callee ? { callee: end.callee } : {}),
            ...(offTopic ? { offTopic: true as const } : {}),
          });
          byFile.set(end.path, evidence);
          if (connects) connectionFiles.add(end.path);
          else associateFiles.add(end.path);
          if (!extraRead || alreadyRead || seenNew.has(end.path)) continue;
          seenNew.add(end.path);
          connectionPaths.push(end.path);
        }
      }
      let importDropped = 0;
      for (const seed of seedPaths) {
        signal.throwIfAborted();
        importersRequested.add(seed);
        const importers = await deps.graph.findImporters(seed);
        signal.throwIfAborted();
        const rankedImporters = rankReverseImporters(
          seed,
          importers.resolved,
          DEFAULT_GRAPH_IMPORT_PER_SEED,
          input.paths,
        );
        for (const importer of rankedImporters) {
          if (seedPaths.includes(importer.path) || !pathInRoots(importer.path, input.paths)) continue;
          const alreadyRead = readPaths.has(importer.path);
          if (!alreadyRead && importPaths.length >= DEFAULT_GRAPH_IMPORT_BUDGET) {
            importDropped += 1;
            continue;
          }
          const evidence = byFile.get(importer.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "import",
            why: `imports ${seed}`,
            locate: { text: importer.specifier, kind: "literal" },
            arrivalReason: arrivalForImport(importer.specifier, seed, parsed, prepared),
          });
          byFile.set(importer.path, evidence);
          importFiles.add(importer.path);
          if (alreadyRead || seenNew.has(importer.path)) continue;
          seenNew.add(importer.path);
          importPaths.push(importer.path);
        }
      }
      // Resolved call edges from materialized windows (D-240): a stored
      // `calls` row's target file is where the callee resolves — a real
      // follow-the-code hop the way an import edge is.
      let relationDropped = 0;
      const relationPaths: string[] = [];
      for (const window of prepared) {
        signal.throwIfAborted();
        const relations = await deps.graph.fileRelations(window.path);
        signal.throwIfAborted();
        if (!relations) continue;
        for (const site of relations.calls ?? []) {
          if (!site.targetPath || !pathInRoots(site.targetPath, input.paths)) continue;
          const alreadyRead = readPaths.has(site.targetPath);
          if (!alreadyRead && relationPaths.length >= DEFAULT_GRAPH_RELATION_BUDGET) {
            relationDropped += 1;
            continue;
          }
          const evidence = byFile.get(site.targetPath) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "calls",
            why: `${site.caller ?? window.path} calls ${site.targetName ?? site.callee ?? "a symbol"} here`,
            locate: { text: site.targetName ?? site.callee ?? "", kind: "identifier" },
            arrivalReason: arrivalForImport(site.targetName ?? site.callee ?? "", site.targetPath, parsed, prepared),
            edgeKind: "calls",
          });
          byFile.set(site.targetPath, evidence);
          relationFiles.add(site.targetPath);
          if (alreadyRead || seenNew.has(site.targetPath)) continue;
          seenNew.add(site.targetPath);
          relationPaths.push(site.targetPath);
        }
        for (const site of relations.references ?? []) {
          // A reference site in this file pins the symbol's home file as a
          // follow candidate — the definition side of a real use.
          if (!site.targetPath || !pathInRoots(site.targetPath, input.paths)) continue;
          const alreadyRead = readPaths.has(site.targetPath);
          if (!alreadyRead && relationPaths.length >= DEFAULT_GRAPH_RELATION_BUDGET) {
            relationDropped += 1;
            continue;
          }
          const evidence = byFile.get(site.targetPath) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "references",
            why: `definition of ${site.targetName ?? "symbol"} referenced in ${window.path}`,
            locate: { text: site.targetName ?? "", kind: "identifier" },
            arrivalReason: arrivalForImport(site.targetName ?? "", site.targetPath, parsed, prepared),
            edgeKind: "references",
          });
          byFile.set(site.targetPath, evidence);
          relationFiles.add(site.targetPath);
          if (alreadyRead || seenNew.has(site.targetPath)) continue;
          seenNew.add(site.targetPath);
          relationPaths.push(site.targetPath);
        }
      }
      // And the reverse direction: stored call/reference sites that point at
      // the question's symbols from anywhere in the catalog.
      for (const object of parsed.objects) {
        if (!looksLikeSymbolName(object)) continue;
        signal.throwIfAborted();
        relationLookupsRequested.add(`callers:${object}`);
        relationLookupsRequested.add(`calls:${object}`);
        const [callers, made] = await Promise.all([
          deps.graph.findCallers ? deps.graph.findCallers(object) : Promise.resolve([]),
          deps.graph.findCalls ? deps.graph.findCalls(object) : Promise.resolve([]),
        ]);
        signal.throwIfAborted();
        for (const site of [
          ...callers.map((entry) => ({ path: entry.path, locate: object, why: `calls ${object}` })),
          ...made.flatMap((entry) => (entry.targetPath ? [{ path: entry.targetPath, locate: entry.targetName ?? entry.callee ?? object, why: `${object} calls ${entry.targetName ?? entry.callee ?? "a symbol"} here` }] : [])),
        ]) {
          if (!pathInRoots(site.path, input.paths)) continue;
          const alreadyRead = readPaths.has(site.path);
          if (!alreadyRead && relationPaths.length >= DEFAULT_GRAPH_RELATION_BUDGET) {
            relationDropped += 1;
            continue;
          }
          const evidence = byFile.get(site.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "calls",
            why: site.why,
            locate: { text: site.locate, kind: "identifier" },
            arrivalReason: "object-triggered",
            edgeKind: "calls",
          });
          byFile.set(site.path, evidence);
          relationFiles.add(site.path);
          if (alreadyRead || seenNew.has(site.path)) continue;
          seenNew.add(site.path);
          relationPaths.push(site.path);
        }
      }
      if (connectionDropped > 0 || importDropped > 0 || relationDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, connectionDropped, importDropped, relationDropped);
        graphPartial = true;
      }
      // A graph clue landing on an already-read file is otherwise never located
      // in its text, because that path is not a newcomer to materialize.
      await refreshReadEvidence();
      ranked = rankNow();
      const newcomers = ranked.filter((candidate) => (
        (connectionPaths.includes(candidate.path) || importPaths.includes(candidate.path) || relationPaths.includes(candidate.path))
        && !readPaths.has(candidate.path)
        && !issues.some((issue) => issue.path === candidate.path)
      ));
      const extraBatch = scheduleReads(newcomers, groups, parsed).slice(0, maxMaterializeReads(newcomers.length, excerptLimit));
      for (let offset = 0; offset < extraBatch.length; offset += DEFAULT_READ_PARALLELISM) {
        signal.throwIfAborted();
        const slice = extraBatch.slice(offset, offset + DEFAULT_READ_PARALLELISM);
        reads += slice.length;
        await materializeBatch(slice);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      graphPartial = true;
    }
  }

    filesDropped = Math.max(filesDropped, graphFilesDropped);
    if (graphFilesDropped > 0) searchIncomplete = true;
    freezeViews();
  };

  const viewsForModel = (byteBudget = DEFAULT_MODEL_INPUT_BYTES) => {
    if (!viewsFrozen) freezeViews(byteBudget);
    return {
      views: frozenViews,
      unevaluated: unevaluatedViewCount,
      ...(planHypotheses ? { hypotheses: planHypotheses } : {}),
    };
  };

  const windowFromView = (view: ExploreQueryView, startLine: number, endLine: number, required: boolean): PreparedWindow | undefined => {
    const snapshot = snapshots.get(view.path);
    if (!snapshot || snapshot.status !== "ready") return undefined;
    if (snapshot.revision !== view.revision) return undefined;
    const lines = snapshot.content.split(/\r\n|\n|\r/);
    if (startLine < 1 || endLine > lines.length || startLine > endLine) return undefined;
    if (startLine < view.startLine || endLine > view.endLine) return undefined;
    const text = lines.slice(startLine - 1, endLine).join("\n");
    const preparedWindow = prepared.find((item) => (
      item.path === view.path && item.start === view.startLine && item.end === view.endLine && item.revision === view.revision
    ));
    const window: PreparedWindow = {
      path: view.path,
      start: startLine,
      end: endLine,
      text,
      groups: preparedWindow?.groups ?? new Set(),
      distinctive: preparedWindow?.distinctive ?? new Set(),
      hasDistinctive: preparedWindow?.hasDistinctive ?? false,
      hasAnchor: preparedWindow?.hasAnchor ?? false,
      offTopic: preparedWindow?.offTopic ?? false,
      windowWeight: preparedWindow?.windowWeight ?? 0,
      revision: view.revision,
      source: view.source,
      why: view.why,
      ...(view.unit ? { unit: view.unit } : {}),
      ...(preparedWindow?.structure ? { structure: preparedWindow.structure } : {}),
      hitLines: (preparedWindow?.hitLines ?? []).filter((line) => line >= startLine && line <= endLine),
      arrivals: view.arrivals,
      assessment: view.assessment,
      purpose: required ? "primary" : "support",
      verifiedCallees: preparedWindow?.verifiedCallees ?? [],
      verifiedRelations: preparedWindow?.verifiedRelations ?? [],
      factKey: preparedWindow?.factKey ?? `${view.path}:${startLine}-${endLine}`,
      roleFit: preparedWindow?.roleFit ?? 0,
    };
    return window;
  };

  const applySelection = (
    selectionGroups: readonly ExploreQuerySelectionGroup[],
    selectionOptions?: { merge?: boolean },
  ): ExploreQuerySelectResult => {
    if (terminal !== "active") {
      return {
        queryId: "",
        accepted: [],
        rejected: [{ reason: "query is no longer active" }],
        gaps: [],
      };
    }
    const accepted: ExploreQuerySelectResult["accepted"] = [];
    const rejected: ExploreQuerySelectResult["rejected"] = [];
    const gaps = [...selectionGroups.flatMap((group) => group.gap ? [group.gap] : [])];
    const built: ChosenGroup[] = [];
    const byId = new Map(frozenViews.map((view) => [view.viewId, view]));
    for (const group of selectionGroups) {
      const viewIds: string[] = [];
      const windows: PreparedWindow[] = [];
      const requiredFlags: boolean[] = [];
      let invalidRequired = false;
      for (const item of group.views) {
        const view = byId.get(item.viewId);
        if (!view) {
          rejected.push({ groupId: group.id, viewId: item.viewId, reason: "unknown or unevaluated view" });
          if (item.required !== false) invalidRequired = true;
          continue;
        }
        const required = item.required !== false;
        const ranges = item.rangeIds?.length
          ? item.rangeIds.map((rangeId) => {
            const range = view.ranges.find((entry) => entry.rangeId === rangeId);
            return range ? { startLine: range.startLine, endLine: range.endLine, required } : undefined;
          })
          : [{
            startLine: item.startLine ?? view.startLine,
            endLine: item.endLine ?? view.endLine,
            required,
          }];
        const itemWindows: PreparedWindow[] = [];
        const itemRequiredFlags: boolean[] = [];
        let ok = Number.isSafeInteger(ranges[0]?.startLine) && Number.isSafeInteger(ranges[0]?.endLine);
        for (const range of ranges) {
          if (!range) {
            rejected.push({ groupId: group.id, viewId: item.viewId, reason: "unknown range" });
            ok = false;
            continue;
          }
          if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)) {
            rejected.push({ groupId: group.id, viewId: item.viewId, reason: "range lines must be safe integers" });
            ok = false;
            continue;
          }
          const window = windowFromView(view, range.startLine, range.endLine, range.required);
          if (!window) {
            rejected.push({ groupId: group.id, viewId: item.viewId, reason: "range is outside the seen view or revision is stale" });
            ok = false;
            continue;
          }
          itemWindows.push(window);
          itemRequiredFlags.push(range.required);
        }
        if (ok) {
          for (const [index, window] of itemWindows.entries()) {
            const key = `${window.path}@${window.revision}:${window.start}-${window.end}`;
            const existing = windows.findIndex((candidate) => (
              `${candidate.path}@${candidate.revision}:${candidate.start}-${candidate.end}` === key
            ));
            if (existing === -1) {
              windows.push(window);
              requiredFlags.push(itemRequiredFlags[index]!);
            } else if (itemRequiredFlags[index]) {
              requiredFlags[existing] = true;
            }
          }
          if (!viewIds.includes(item.viewId)) viewIds.push(item.viewId);
        } else if (required) {
          invalidRequired = true;
        }
      }
      if (invalidRequired) {
        gaps.push(`material group ${group.id} contains a required range the Host could not validate`);
        continue;
      }
      const requiredCount = requiredFlags.filter(Boolean).length;
      if (requiredCount > excerptLimit) {
        rejected.push({ groupId: group.id, reason: "required group exceeds excerpt limit" });
        gaps.push(`material group ${group.id} cannot be presented intact under the excerpt limit`);
        continue;
      }
      if (viewIds.length > 0 && windows.length > 0) {
        accepted.push({ groupId: group.id, viewIds });
        built.push({ id: group.id, purpose: group.purpose, windows, requiredFlags });
      }
    }
    if (selectionOptions?.merge) {
      const byGroup = new Map(chosenGroups.map((group) => [group.id, group]));
      for (const next of built) byGroup.set(next.id, next);
      chosenGroups = [...byGroup.values()];
    } else {
      chosenGroups = built;
    }
    selectionGaps = selectionOptions?.merge ? uniqueGaps([...selectionGaps, ...gaps]) : uniqueGaps(gaps);
    return { queryId: "", accepted, rejected, gaps };
  };

  const applyRerank = (scores: readonly ExploreRerankScore[], details: ExploreRerankDetails): void => {
    rerankDetails = details;
    if (!viewsFrozen) freezeViews();
    const byView = new Map(frozenViews.map((view, index) => [view.viewId, { view, index }]));
    const scored = scores
      .filter((score) => byView.has(score.viewId) && Number.isFinite(score.score))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return byView.get(left.viewId)!.index - byView.get(right.viewId)!.index;
      });
    const seen = new Set(scored.map((score) => score.viewId));
    frozenViews = [...scored.map((score) => byView.get(score.viewId)!.view), ...frozenViews.filter((view) => !seen.has(view.viewId))];
    const order = new Map(frozenViews.map((view, index) => [`${view.path}:${view.startLine}-${view.endLine}`, index]));
    prepared.sort((left, right) => {
      const leftOrder = order.get(`${left.path}:${left.start}-${left.end}`) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(`${right.path}:${right.start}-${right.end}`) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  };

  const submitPlan = async (plan: ExploreGroupedSearchPlan): Promise<{ launched: string[]; reused: string[] }> => {
    if (terminal !== "active" || signal.aborted) return { launched: [], reused: [] };
    planHypotheses = {
      behavior: plan.behavior,
      expectedMaterials: plan.groups.flatMap((group) => group.expectedMaterials ?? []),
    };
    const launched: string[] = [];
    const reused: string[] = [];
    for (const group of plan.groups) {
      const expressions = [...new Set(group.expressions.map((item) => item.trim()).filter(Boolean))];
      if (expressions.length === 0) continue;
      const fresh = expressions.filter((expression) => !launchedExpressions.has(expression));
      for (const expression of expressions) {
        if (launchedExpressions.has(expression)) reused.push(expression);
        else launchedExpressions.add(expression);
      }
      if (fresh.length === 0) continue;
      const term: TermGroup = {
        id: `plan:${group.id}:${fresh.join("|")}`,
        kind: "plan",
        distinctive: group.concept.trim() || fresh[0]!,
        variants: fresh,
      };
      groups.push(term);
      const patterns = collectPatterns([term]);
      launched.push(...fresh);
      launchTask(`plan:${group.id}:${fresh.join("\0")}`, "plan", true, async () => {
        const statuses = await Promise.all([
          runRg(patterns),
          runSemanticQueries(fresh),
        ]);
        return combineProductionStatuses(statuses);
      });
    }
    if (launched.length > 0) {
      notifyProgress();
      kickPump();
    }
    return { launched, reused };
  };

  /** Locate a real symbol's definitions and attach them as clues (followup/action shared). */
  const locateSymbolTarget = async (value: string): Promise<void> => {
    if (!deps.graph) return;
    symbolsSearched.add(value);
    const hits = await deps.graph.searchDefinitions(value, DEFAULT_GRAPH_DEFINITIONS_PER_TERM);
    signal.throwIfAborted();
    for (const hit of hits) {
      if (!pathInRoots(hit.path, input.paths)) continue;
      const evidence = byFile.get(hit.path) ?? emptyEvidence();
      attachGraphClue(evidence, {
        source: "definition",
        why: `definition of ${hit.name} (${hit.kind})`,
        locate: { text: hit.name, kind: "identifier" },
        arrivalReason: "object-triggered",
        match: hit.match === "exact" ? "exact" : "name-contains",
      });
      byFile.set(hit.path, evidence);
      definitionFiles.add(hit.path);
    }
  };

  /** Follow a connection literal to its endpoints (followup locate/action shared). */
  const followConnectionLiteral = async (value: string): Promise<void> => {
    if (!deps.graph) return;
    linksRequested.add(value);
    const ends = await deps.graph.findLinks(value);
    signal.throwIfAborted();
    for (const end of ends) {
      if (!pathInRoots(end.path, input.paths)) continue;
      const evidence = byFile.get(end.path) ?? emptyEvidence();
      attachGraphClue(evidence, {
        source: end.kind === "connects" ? "connection" : "association",
        why: `other end of connection "${value}"`,
        locate: { text: value, kind: "literal" },
        arrivalReason: "object-triggered",
        edgeKind: end.kind === "connects" ? "connects" : "associates",
        ...(end.callee ? { callee: end.callee } : {}),
      });
      byFile.set(end.path, evidence);
    }
  };

  /**
   * Attach the sites a resolved relation lookup returns (followup action
   * execution). Mirrors the seed relation loop but without its budget: the
   * model already chose this specific expansion.
   */
  const attachRelationSites = async (
    kind: "callers" | "references" | "calls",
    name: string,
  ): Promise<void> => {
    if (!deps.graph) return;
    relationLookupsRequested.add(`${kind}:${name}`);
    const lookup = kind === "callers"
      ? deps.graph.findCallers
      : kind === "references"
        ? deps.graph.findReferences
        : deps.graph.findCalls;
    if (!lookup) return;
    const sites = await lookup(name);
    signal.throwIfAborted();
    for (const site of sites) {
      // `calls` answers "what does name call": the follow target is the
      // resolved callee's file; callers/references land on the site itself.
      const targetPath = kind === "calls" ? site.targetPath : site.path;
      const locateText = kind === "calls" ? site.targetName ?? site.callee ?? name : name;
      if (!targetPath || !pathInRoots(targetPath, input.paths)) continue;
      const evidence = byFile.get(targetPath) ?? emptyEvidence();
      attachGraphClue(evidence, {
        source: kind === "calls" ? "calls" : kind,
        why: kind === "calls"
          ? `${name} calls ${locateText} here`
          : kind === "callers" ? `calls ${name}` : `references ${name}`,
        locate: { text: locateText, kind: "identifier" },
        arrivalReason: "object-triggered",
        edgeKind: kind === "callers" ? "calls" : kind,
      });
      byFile.set(targetPath, evidence);
      relationFiles.add(targetPath);
    }
  };

  const attachImporterClues = async (path: string): Promise<void> => {
    if (!deps.graph) return;
    importersRequested.add(path);
    const importers = await deps.graph.findImporters(path);
    signal.throwIfAborted();
    for (const importer of rankReverseImporters(path, importers.resolved, DEFAULT_GRAPH_IMPORT_PER_SEED, input.paths)) {
      const evidence = byFile.get(importer.path) ?? emptyEvidence();
      attachGraphClue(evidence, {
        source: "import",
        why: `imports ${path}`,
        locate: { text: importer.specifier, kind: "literal" },
        arrivalReason: arrivalForImport(importer.specifier, path, parsed, prepared),
      });
      byFile.set(importer.path, evidence);
      importFiles.add(importer.path);
    }
  };

  /**
   * Materialize a path an action chose: locate hint, explicit range, or the
   * whole file. Unlike graph-expansion actions this is itself a read
   * instruction, so it reads through `materializeBatch` directly instead of
   * waiting for the ranker — a chosen read must produce its material.
   */
  const readActionTarget = async (action: ExploreQueryAction): Promise<void> => {
    if (!pathInRoots(action.target, input.paths)) return;
    const evidence = byFile.get(action.target) ?? emptyEvidence();
    if (action.locate) {
      attachGraphClue(evidence, {
        source: "action",
        why: action.why,
        locate: action.locate,
        arrivalReason: "object-triggered",
        edgeKind: "action",
      });
    }
    const hasRange = action.startLine !== undefined && action.endLine !== undefined;
    if (hasRange || !action.locate) {
      const focus = {
        startLine: hasRange ? Math.max(1, Math.trunc(action.startLine!)) : 1,
        endLine: hasRange ? Math.max(1, Math.trunc(action.endLine!)) : Number.MAX_SAFE_INTEGER,
        why: action.why,
      };
      if (!evidence.readFocuses.some((item) => (
        item.startLine === focus.startLine && item.endLine === focus.endLine
      ))) evidence.readFocuses.push(focus);
    }
    byFile.set(action.target, evidence);
    if (readPaths.has(action.target)) {
      await refreshReadEvidence();
      return;
    }
    reads += 1;
    await materializeBatch([{ path: action.target, evidence, roleFit: 0, rrf: 0, hasRankedSource: true }]);
  };

  /**
   * Real next-step candidates derived from material this query already read
   * (D-312). Identities are deterministic (`kind:target[:range]`), so issuing
   * the same step twice dedups; executed ids never come back.
   */
  const actionCandidates = async (): Promise<ExploreQueryAction[]> => {
    const candidates: ExploreQueryAction[] = [];
    const offer = (candidate: Omit<ExploreQueryAction, "actionId">): void => {
      const range = candidate.startLine !== undefined && candidate.endLine !== undefined
        ? `:${candidate.startLine}-${candidate.endLine}`
        : "";
      const actionId = `${candidate.kind}:${candidate.target}${range}`;
      if (executedActions.has(actionId)) return;
      const existing = issuedActions.get(actionId);
      if (existing) {
        candidates.push(existing);
        return;
      }
      const issued: ExploreQueryAction = { ...candidate, actionId };
      issuedActions.set(actionId, issued);
      candidates.push(issued);
    };
    if (!deps.graph) return candidates;
    for (const path of readPaths) {
      signal.throwIfAborted();
      const relations = await deps.graph.fileRelations(path).catch(() => null);
      if (!relations) continue;
      for (const connection of relations.connections) {
        if (linksRequested.has(connection.literal)) continue;
        offer({
          kind: "connect",
          target: connection.literal,
          why: `connection literal "${connection.literal}" used in ${path}`,
        });
      }
      for (const site of [...(relations.calls ?? []), ...(relations.references ?? [])]) {
        const name = site.targetName ?? site.callee;
        if (site.targetPath && !readPaths.has(site.targetPath)) {
          offer({
            kind: "read",
            target: site.targetPath,
            ...(name ? { locate: { text: name, kind: "identifier" as const } } : {}),
            why: `${site.caller ?? path} ${site.targetName ? `calls ${site.targetName}` : "references a symbol"} here`,
          });
        } else if (!site.targetPath && name && looksLikeSymbolName(name) && !symbolsSearched.has(name)) {
          offer({
            kind: "symbol",
            target: name,
            why: `unresolved ${name} referenced in ${path}`,
          });
        }
      }
      if (!importersRequested.has(path)) {
        offer({ kind: "importers", target: path, why: `files importing ${path}` });
      }
      const evidence = byFile.get(path);
      for (const name of evidence?.verifiedCallees ?? []) {
        if (!looksLikeSymbolName(name)) continue;
        if (!symbolsSearched.has(name)) {
          offer({ kind: "symbol", target: name, why: `verified callee ${name} in ${path}` });
        }
        for (const kind of ["callers", "references", "calls"] as const) {
          if (relationLookupsRequested.has(`${kind}:${name}`)) continue;
          offer({ kind, target: name, why: `${kind} of verified callee ${name} in ${path}` });
        }
      }
    }
    return candidates;
  };

  const followup = async (request: Omit<ExploreQueryFollowupParams, "queryId">): Promise<{
    launched: string[];
    reused: string[];
    newViews: ExploreQueryView[];
    actionsExecuted: string[];
    actionsRejected: Array<{ actionId: string; reason: string }>;
  }> => {
    if (terminal !== "active" || signal.aborted) return { launched: [], reused: [], newViews: [], actionsExecuted: [], actionsRejected: [] };
    const before = new Set(frozenViews.map((view) => viewLogicalKey(view)));
    const launched: string[] = [];
    const reused: string[] = [];
    const actionsExecuted: string[] = [];
    const actionsRejected: Array<{ actionId: string; reason: string }> = [];
    const searches = request.searches ?? [];
    const expressions = [...new Set(searches.map((item) => item.expression.trim()).filter(Boolean))];
    const fresh = expressions.filter((expression) => !launchedExpressions.has(expression));
    for (const expression of expressions) {
      if (launchedExpressions.has(expression)) reused.push(expression);
      else launchedExpressions.add(expression);
    }
    if (fresh.length > 0) {
      const term: TermGroup = {
        id: `followup:${fresh[0]}`,
        kind: "plan",
        distinctive: fresh[0]!,
        variants: fresh,
      };
      groups.push(term);
      launched.push(...fresh);
      launchTask(`followup:${fresh.join("|")}`, "followup", true, async () => {
        const statuses = await Promise.all([
          runRg(collectPatterns([term])),
          runSemanticQueries(fresh),
        ]);
        return combineProductionStatuses(statuses);
      });
    }
    for (const locate of request.locates ?? []) {
      const value = locate.value.trim();
      if (!value) continue;
      const taskId = `locate:${locate.kind}:${value}`;
      if (tasks.has(taskId)) {
        reused.push(value);
        continue;
      }
      launched.push(value);
      launchTask(taskId, "followup", true, async () => {
        if (locate.kind === "path" && looksLikePathObject(value) && pathInRoots(value, input.paths)) {
          if (!byFile.has(value)) byFile.set(value, emptyEvidence());
          return;
        }
        if (locate.kind === "symbol") return locateSymbolTarget(value);
        return followConnectionLiteral(value);
      });
    }
    // Fast-decision actions (D-312): the caller picks issued ids; the query
    // owner executes the recorded candidate, not the wire payload's fields.
    for (const requested of request.actions ?? []) {
      const issued = issuedActions.get(requested.actionId);
      if (!issued) {
        actionsRejected.push({ actionId: requested.actionId, reason: "unknown or stale action candidate" });
        continue;
      }
      if (executedActions.has(issued.actionId)) {
        reused.push(issued.actionId);
        continue;
      }
      executedActions.add(issued.actionId);
      actionsExecuted.push(issued.actionId);
      launched.push(issued.actionId);
      launchTask(`action:${issued.actionId}`, "followup", true, async () => {
        switch (issued.kind) {
          case "symbol":
            return locateSymbolTarget(issued.target);
          case "connect":
            return followConnectionLiteral(issued.target);
          case "importers":
            return attachImporterClues(issued.target);
          case "callers":
          case "references":
          case "calls":
            return attachRelationSites(issued.kind, issued.target);
          case "path":
          case "read":
            return readActionTarget(issued);
        }
      });
    }
    if (launched.length > 0) notifyProgress();
    await awaitPump();
    if (request.gaps?.length) selectionGaps = uniqueGaps([...selectionGaps, ...request.gaps]);
    freezeViews();
    return {
      launched,
      reused,
      newViews: frozenViews.filter((view) => !before.has(viewLogicalKey(view))),
      actionsExecuted,
      actionsRejected,
    };
  };

  const packChosenGroups = (): {
    packed: PreparedWindow[];
    omittedRequired: ExploreResult["omitted"];
    requiredKeys: Set<string>;
    gaps: string[];
  } => {
    const packed: PreparedWindow[] = [];
    const omittedRequired: ExploreResult["omitted"] = [];
    const requiredKeys = new Set<string>();
    const packedKeys = new Set<string>();
    const acceptedGroups: ChosenGroup[] = [];
    const gaps: string[] = [];
    const keyOf = (window: PreparedWindow): string => `${window.path}@${window.revision}:${window.start}-${window.end}`;

    // Required ranges from every group get first claim on the excerpt cap.
    // Auxiliary ranges from an early group cannot evict a later required group.
    for (const group of chosenGroups) {
      const required = group.windows.filter((_, index) => group.requiredFlags[index]);
      const newRequired = required.filter((window) => !packedKeys.has(keyOf(window)));
      if (newRequired.length > excerptLimit || packed.length + newRequired.length > excerptLimit) {
        gaps.push(`material group ${group.id} cannot be presented intact under the excerpt limit`);
        omittedRequired.push(...group.windows.map((window) => ({
          path: window.path,
          startLine: window.start,
          endLine: window.end,
          reason: "required group exceeds excerpt limit",
        })));
        continue;
      }
      acceptedGroups.push(group);
      for (const window of required) {
        const key = keyOf(window);
        requiredKeys.add(key);
        if (packedKeys.has(key)) continue;
        packedKeys.add(key);
        packed.push(window);
      }
    }
    for (const group of acceptedGroups) {
      for (const window of group.windows.filter((_, index) => !group.requiredFlags[index])) {
        if (packed.length >= excerptLimit) break;
        const key = keyOf(window);
        if (packedKeys.has(key)) continue;
        packedKeys.add(key);
        packed.push(window);
      }
    }
    return { packed, omittedRequired, requiredKeys, gaps };
  };

  const finish = (model?: ExploreModelParticipation): ExploreResult => {
    if (terminal === "cancelled") {
      const error = new Error("Explore query cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (terminal === "finished" && frozenResult) return frozenResult;
    if (!viewsFrozen) freezeViews();
    const ranked = rankNow();
    const packWeights = weightByGroupId(groups, buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf));
    const locatingDone = !allSites && locating && hasVerifiedRegister(prepared);
    const bothEndsDone = !allSites && wantsBothEnds && hasBothConnectsEnds(prepared);
    const chosenPack = chosenGroups.length > 0 ? packChosenGroups() : undefined;
    const packed = chosenPack
      ? chosenPack.packed
      : packComplementary(
        prepared,
        excerptLimit,
        packWeights,
        locatingDone || bothEndsDone,
        parsed.preferTests === false,
        explicitNavigation,
      );
    const packedKeys = new Set(packed.map((window) => `${window.path}:${window.start}-${window.end}`));
    for (const window of prepared) {
      const packedWindow = packedKeys.has(`${window.path}:${window.start}-${window.end}`);
      window.purpose = packedWindow ? (window.offTopic ? "support" : "primary") : "candidate";
    }
    const requiredKeys = chosenPack?.requiredKeys ?? new Set<string>();
    for (const window of packed) {
      if (requiredKeys.has(`${window.path}@${window.revision}:${window.start}-${window.end}`)) window.purpose = "primary";
    }
    const distinctiveness = buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf);
    const windowTraces: ExploreWindowTrace[] = prepared.map((window) => {
      const evidence = byFile.get(window.path);
      return {
        path: window.path,
        startLine: window.start,
        endLine: window.end,
        why: window.why,
        packed: packedKeys.has(`${window.path}:${window.start}-${window.end}`),
        arrivals: window.arrivals,
        assessment: window.assessment,
        purpose: window.purpose,
        ...(window.unit ? { unit: window.unit } : {}),
        hits: window.hitLines.flatMap((line) => {
          const text = evidence?.hits.get(line)?.text;
          return text ? [text] : [];
        }),
      };
    });
    const unread = ranked
      .map((candidate) => candidate.path)
      .filter((path) => !provenance.has(path) || provenance.get(path)?.status === "not-requested");
    for (const path of unread) markProvenance(path, "not-requested");

    const graphDetails: ExploreGraphDetails = {
      status: graphStatus,
      definitions: definitionFiles.size,
      connections: connectionFiles.size,
      ...(associateFiles.size > 0 ? { associates: associateFiles.size } : {}),
      imports: importFiles.size,
      ...(relationFiles.size > 0 ? { relations: relationFiles.size } : {}),
      ...(graphFilesDropped > 0 ? { filesDropped: graphFilesDropped } : {}),
      ...(graphPartial ? { partial: true } : {}),
    };
    const snippets = packed.map((window) => ({
      ...snippetFrom(window),
      ...(requiredKeys.has(`${window.path}@${window.revision}:${window.start}-${window.end}`) ? { required: true as const } : {}),
    }));
    const omittedRequiredKeys = new Set(
      (chosenPack?.omittedRequired ?? []).map((item) => `${item.path}:${item.startLine}-${item.endLine}`),
    );
    const omitted = [
      ...(chosenPack?.omittedRequired ?? []),
      ...prepared
        .filter((window) => {
          const key = `${window.path}:${window.start}-${window.end}`;
          return !packedKeys.has(key) && !omittedRequiredKeys.has(key);
        })
        .map((window) => ({
          path: window.path,
          startLine: window.start,
          endLine: window.end,
          reason: "not selected for complementary pack",
        })),
      ...[...selectionGaps, ...(chosenPack?.gaps ?? [])].map((gap) => ({
        path: "(gap)",
        startLine: 0,
        endLine: 0,
        reason: gap,
      })),
    ];
    abortLeftoverSources();
    const sources = sourceStates();
    const sourceIncomplete = sources.some((source) => (
      source.status === "incomplete" || source.status === "cancelled" || source.status === "failed"
    ));
    if (sourceIncomplete) searchIncomplete = true;
    const semanticTask = sources.find((source) => source.family === "semantic");
    if (semanticTask && (semanticTask.status === "incomplete" || semanticTask.status === "cancelled")) {
      if (semanticReport.status === "unavailable" || semanticReport.status === "not-requested") {
        semanticReport = { ...semanticReport, status: "incomplete" };
      }
    }
    const partial = issues.length > 0 || omitted.length > 0 || unread.length > 0 || searchIncomplete || snippets.length < prepared.length || graphPartial || sourceIncomplete;
    terminal = "finished";
    frozenResult = {
      snippets,
      issues,
      notRequested: { count: unread.length, paths: unread },
      omitted,
      partial,
      searchIncomplete,
      searched: {
        patterns: launchedPatterns,
        files: byFile.size,
        ms: now() - startedAt,
        incomplete: searchIncomplete,
        ...(filesDropped > 0 ? { filesDropped } : {}),
      },
      details: {
        provenance: [...provenance.values()].sort((left, right) => comparePath(left.path, right.path)),
        anchors: { supplied: suppliedAnchors, used: usedAnchors, truncated: anchorsTruncated },
        byteBudget: DEFAULT_BYTE_BUDGET,
        ...(structureFiles.size > 0
          ? { structure: { files: [...structureFiles.values()].sort((left, right) => comparePath(left.path, right.path)) } }
          : {}),
        graph: graphDetails,
        query: { objects: parsed.objects, relation: parsed.relation, domain: parsed.domain },
        ...(skippedContent.length > 0
          ? { skippedQueries: { reason: "direct-verified" as const, patterns: skippedContent } }
          : {}),
        distinctiveness,
        ...(windowTraces.length > 0 ? { windows: windowTraces } : {}),
        semantic: {
          ...semanticReport,
          blocks: semanticBlocks,
          units: windowTraces.filter((window) => window.arrivals.some((item) => item.kind === "semantic")).length,
          primary: windowTraces.filter((window) => (
            window.purpose === "primary" && window.arrivals.some((item) => item.kind === "semantic")
          )).length,
        },
        ...(model ? { model } : {}),
        ...(rerankDetails ? { rerank: rerankDetails } : {}),
        ...(fastDecisionDetails ? { fastDecision: fastDecisionDetails } : {}),
        sources,
      },
    };
    return frozenResult;
  };

  const applyFastDecision = (details: ExploreFastDecisionDetails): void => {
    fastDecisionDetails = details;
  };

  const cancel = (): void => {
    if (terminal !== "active") return;
    terminal = "cancelled";
    notifyProgress();
    controller.abort();
  };

  const sourceStates = (): ExploreQuerySourceState[] => [...tasks.values()].map((task) => ({
    id: task.id,
    family: task.family,
    status: task.status,
  }));

  const vocab = (): ExploreQueryVocab => ({
    objects: parsed.objects,
    anchors: usedAnchors,
    ...(catalogVocab ? { catalog: catalogVocab } : {}),
    ...(catalogPackages ? { packages: catalogPackages } : {}),
    ...(catalogEntries ? { entries: catalogEntries } : {}),
  });

  return {
    start,
    submitPlan,
    waitForViews,
    waitForProgress,
    viewsForModel,
    applySelection,
    applyRerank,
    followup,
    actionCandidates,
    applyFastDecision,
    finish,
    cancel,
    refreshVocab,
    parsed,
    deadlineAt,
    question: input.question,
    signal,
    terminal: terminalState,
    sourceStates,
    vocab,
  };
}

export async function explore(
  input: ExploreInput,
  deps: ExploreDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExploreResult> {
  const run = createExploreQueryRun(input, deps, { signal });
  run.start();
  await run.waitForViews();
  return run.finish();
}

export type ExploreFormatInput = Pick<
  ExploreResult,
  "snippets" | "issues" | "notRequested" | "omitted" | "partial" | "searchIncomplete" | "searched"
> & {
  relations?: NonNullable<WireResult["details"]["relations"]>;
  graph?: ExploreGraphDetails;
  skippedQueries?: NonNullable<WireResult["details"]["skippedQueries"]>;
  model?: ExploreModelParticipation;
  semantic?: ExploreSemanticDetails;
  sources?: ExploreQuerySourceState[];
  /** Count/handle projection for staged model calls. Full paths stay in the output store. */
  omittedCount?: number;
  summaryOnly?: boolean;
};

/**
 * Relations are an annotation, so they are capped per file and never printed
 * as current when the graph revision differs from the excerpt: a moved line
 * number is worse than no line number (agent-harness 7.2, D-112).
 */
const RELATION_LINES_PER_FILE = 12;

function relationLines(relations: NonNullable<WireResult["details"]["relations"]> | undefined): string[] {
  if (!relations) return [];
  const files = relations.files.filter((file) => (
    file.imports.length > 0
    || file.connections.length > 0
    || file.associations.length > 0
    || (file.references?.length ?? 0) > 0
    || (file.calls?.length ?? 0) > 0
  ));
  const lines: string[] = [];
  if (relations.status !== "ready") {
    lines.push(`Relations ${relations.status}: the symbol graph could not answer for every excerpt path.`);
  }
  if (files.length === 0) return lines;
  lines.push("Relations (graph; associates are same-string candidates, not confirmed connections):");
  for (const file of files) {
    const where = file.stale
      ? `${file.path} [stale @${file.documentRevision ?? "unknown"}; line numbers are from that revision]`
      : file.path;
    const items = [
      ...file.connections.map((item) => `connects ${item.callee}("${item.literal}")${file.stale ? "" : ` (L${item.line})`}`),
      ...file.imports.map((item) => `imports ${item.specifier}${file.stale ? "" : ` (L${item.line})`}`),
      ...file.associations.map((item) => `associates ${item.callee}("${item.literal}")${file.stale ? "" : ` (L${item.line})`} [candidate]`),
      ...(file.references ?? []).map((item) => `references ${item.value}${item.caller ? ` in ${item.caller}` : ""}${item.targetPath ? ` → ${item.targetPath}` : ""}${file.stale ? "" : ` (L${item.line})`}${item.pinned ? "" : " [unpinned]"}${item.staleTarget ? " [stale-target]" : ""}`),
      ...(file.calls ?? []).map((item) => `calls ${item.callee}${item.caller ? ` from ${item.caller}` : ""}${item.targetPath ? ` → ${item.targetPath}` : ""}${file.stale ? "" : ` (L${item.line})`}${item.pinned ? "" : " [unpinned]"}${item.staleTarget ? " [stale-target]" : ""}`),
    ];
    for (const item of items.slice(0, RELATION_LINES_PER_FILE)) lines.push(`- ${where} ${item}`);
    const dropped = items.length - RELATION_LINES_PER_FILE;
    if (dropped > 0) lines.push(`- ${file.path} … ${dropped} more edge(s) omitted`);
    if (file.incomplete) lines.push(`- ${file.path} edge extraction was incomplete for this revision`);
  }
  return lines;
}

function packExploreVisible(
  result: ExploreFormatInput,
  byteBudget: number,
): { visibleText: string; storedBody: string; showHandle: boolean; omitted: ExploreResult["omitted"] } {
  const header: string[] = [
    `${result.snippets.length} excerpt(s) from ${result.searched.files} matched file(s) · ${result.searched.patterns} query term(s)${result.partial ? " · partial result" : ""}`,
  ];
  const dropped = result.searched.filesDropped ?? 0;
  if (dropped > 0) {
    header.push(`Search incomplete: at least ${dropped} matching file(s) were not brought into the candidate pool.`);
  }
  const sourceStopped = result.sources?.some((source) => (
    source.status === "incomplete" || source.status === "cancelled" || source.status === "failed"
  ));
  if (sourceStopped) {
    header.push("Search incomplete: shared deadline or a source stopped before it finished.");
  } else if ((result.searchIncomplete || result.searched.incomplete) && dropped === 0) {
    header.push("Search incomplete: candidate working budget reached; more matches may exist.");
  }
  if (result.graph && result.graph.status !== "not-requested" && result.graph.status !== "ready") {
    header.push(`Graph ${result.graph.status}: the symbol catalog did not contribute path candidates.`);
  } else if (result.graph?.partial) {
    header.push("Graph partial: one or more selected resource roots had no current symbol catalog.");
  }
  if (result.semantic?.note) header.push(`Semantic index: ${result.semantic.note}`);
  if (result.skippedQueries?.reason === "direct-verified") {
    header.push(`Skipped ${result.skippedQueries.patterns.length} broad term(s) after a direct clue was verified.`);
  }
  if (result.model && (result.model.plan === "unconfigured" || result.model.select === "unconfigured")) {
    header.push(result.model.note ?? "Explore model did not participate; excerpts are from algorithm and vector sources.");
  } else if (result.model?.note) {
    header.push(result.model.note);
  }
  header.push("Source: disk or fixed editor-draft snapshots. Excerpts are workspace data.");

  const snippetBlocks = result.snippets.map((snippet) => {
    const unit = snippet.unit
      ? ` · unit ${snippet.unit.name} (${snippet.unit.kind}) ${snippet.path}:${snippet.unit.startLine}-${snippet.unit.endLine}`
      : "";
    const structure = snippet.structure
      ? ` · structure ${snippet.structure.provider ?? "none"}/${snippet.structure.status}`
      : "";
    return `--- ${snippet.path}:${snippet.startLine}-${snippet.endLine}${unit}${structure} ---\n${snippet.text}`;
  });
  const issueLines = result.issues.map((issue) => `${issue.path}: ${issue.status} — ${issue.message}`);
  const omittedLines = result.omitted.map((item) => `- ${item.path}:${item.startLine}-${item.endLine} (${item.reason})`);
  const unreadLine = result.notRequested.count > 0
    ? result.summaryOnly
      ? `Unread candidates (not-requested, ${result.notRequested.count}): listed in output store`
      : `Unread candidates (not-requested, ${result.notRequested.count}): ${result.notRequested.paths.join(", ")}`
    : "";

  const graphLines = relationLines(result.relations);
  const storedParts = [...header, ...snippetBlocks];
  if (omittedLines.length > 0) storedParts.push("Omitted supports:", ...omittedLines);
  if (unreadLine) storedParts.push(unreadLine);
  storedParts.push(...issueLines);
  if (graphLines.length > 0) storedParts.push(...graphLines);
  const storedBody = storedParts.join("\n");

  const visible: string[] = [...header];
  const omitted = [...result.omitted];
  const pushIfFits = (line: string): boolean => {
    const next = [...visible, line].join("\n");
    if (utf8Bytes(next) <= byteBudget) {
      visible.push(line);
      return true;
    }
    return false;
  };

  result.snippets.forEach((snippet, index) => {
    const block = snippetBlocks[index]!;
    if (!pushIfFits(block)) {
      omitted.push({
        path: snippet.path,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        reason: snippet.required ? "required range exceeded output budget" : "over byte budget",
      });
    }
  });
  const extraOmitted = omitted.filter((item) => (
    item.reason === "over byte budget" || item.reason === "required range exceeded output budget"
  ));
  if (omitted.length > 0 || (result.summaryOnly === true && (result.omittedCount ?? 0) > 0)) {
    if (result.summaryOnly) {
      const count = (result.omittedCount ?? result.omitted.length) + extraOmitted.length;
      pushIfFits(`Omitted supports (${count}): full list in output store`);
    } else {
      pushIfFits("Omitted supports:");
      for (const item of omitted) {
        pushIfFits(`- ${item.path}:${item.startLine}-${item.endLine} (${item.reason})`);
      }
    }
  }
  if (unreadLine && !pushIfFits(unreadLine) && result.notRequested.count > 0) {
    pushIfFits(`Unread candidates (not-requested, ${result.notRequested.count}): listed in output store`);
  }
  for (const line of issueLines) pushIfFits(line);
  for (const line of graphLines) pushIfFits(line);

  let visibleText = visible.join("\n");
  if (utf8Bytes(visibleText) > byteBudget && !result.snippets.some((snippet) => snippet.required)) {
    const raw = Buffer.from(visibleText, "utf8").subarray(0, byteBudget);
    visibleText = raw.toString("utf8").replace(/\uFFFD$/u, "");
  }
  const showHandle = storedBody !== visibleText
    || extraOmitted.length > 0
    || (result.omittedCount ?? result.omitted.length) > 0
    || result.notRequested.count > 0 && (result.summaryOnly === true || !visibleText.includes(result.notRequested.paths[0] ?? "\0"));
  return { visibleText, storedBody, showHandle, omitted };
}

export function formatExploreOutput(
  result: ExploreFormatInput,
  options?: { byteBudget?: number; handle?: string },
): { visibleText: string; storedBody: string; showHandle: boolean; omitted: ExploreResult["omitted"] } {
  const byteBudget = options?.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const packed = packExploreVisible(result, byteBudget);
  const hint = options?.handle && packed.showHandle ? exploreHandleHint(options.handle) : "";
  if (!hint) return packed;
  const reserved = packExploreVisible(result, Math.max(0, byteBudget - utf8Bytes(hint)));
  let visibleText = `${reserved.visibleText}${hint}`;
  if (utf8Bytes(visibleText) > byteBudget) {
    const raw = Buffer.from(visibleText, "utf8").subarray(0, byteBudget);
    visibleText = raw.toString("utf8").replace(/\uFFFD$/u, "");
  }
  return { ...reserved, visibleText, showHandle: true };
}
