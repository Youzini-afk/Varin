/**
 * D-315 / Stage L1: continuous web search, fixed content snapshots and
 * reusable readable positions.
 *
 * A search request carries a batch of independent items (queries, a natural
 * language objective, known URLs, or a provider pagination cursor). Each item
 * reports its own status; a partial failure never erases material that
 * succeeded elsewhere in the same batch.
 *
 * Fetched content is pinned into a snapshot: an immutable, content-hashed
 * record whose readable positions (extracted-text line ranges) stay valid
 * while the snapshot lives. Refreshing a URL mints a new snapshot; old
 * references keep resolving to the old content.
 */
import type { FetchResult, SearchResultItem } from "./harness.js";

export type WebSearchItemStatus =
  | "ok"
  | "empty"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "partial"
  | "denied"
  | "unsupported";

/**
 * Structural positions a parser actually detected inside the stored body.
 * Entries bind to the snapshot's fixed content — a refresh mints a new
 * snapshot with its own structure.
 */
export interface WebSnapshotStructure {
  /** Page boundaries mapped onto extracted-text lines (one-based). Present
   * only when the parser actually segmented pages (e.g. pdf-text). */
  pages?: Array<{ page: number; startLine: number; endLine: number }>;
  /** Page dimensions are points; line/segment coordinates are normalized 0..1. */
  layouts?: Array<{
    page: number;
    width: number;
    height: number;
    /** The analysis that produced these positions. Coordinates are normalized. */
    analysisId?: string;
    columns?: number;
    lines: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      readingIndex: number;
      region?: WebDocumentRegion;
      segments?: Array<{ text: string; x: number; width: number }>;
    }>;
  }>;
  /** Detected section headings mapped onto extracted-text lines. */
  headings?: Array<{ title: string; level: number; line: number; analysisId?: string; elementId?: string; regions?: DocumentPageRegion[] }>;
  /** Detected table blocks as line ranges in the fixed body. */
  tables?: Array<{
    startLine: number;
    endLine: number;
    page?: number;
    text?: string;
    confidence?: "candidate";
    analysisId?: string;
    elementId?: string;
    regions?: DocumentPageRegion[];
    /** Parser supplied cell topology. `rows` above remains a text-view aid. */
    cells?: DocumentTableCell[];
    rows?: Array<{ cells: Array<{ text: string; x: number; width: number }> }>;
  }>;
  /** Detected figure/image references (markdown image lines). */
  figures?: Array<{
    line: number;
    title?: string;
    text?: string;
    page?: number;
    bbox?: { x: number; y: number; width: number; height: number };
    confidence?: "candidate";
    analysisId?: string;
    elementId?: string;
    regions?: DocumentPageRegion[];
    captions?: Array<{ id: string; text: string; regions: DocumentPageRegion[] }>;
  }>;
  /** Formula candidates from text/layout heuristics; never treated as LaTeX truth. */
  formulas?: Array<{ line: number; text: string; confidence: "candidate"; analysisId?: string; elementId?: string; regions?: DocumentPageRegion[] }>;
  /** Parser reading order. Lines are present only when grounded in its text. */
  blocks?: DocumentStructureBlock[];
  /** Parser elements retain exact geometry even without a text-line mapping. */
  elements?: DocumentStructureElement[];
  /** Aspects this representation honestly cannot express. */
  unparsed?: string[];
}

/** A parser-backed document attached to an immutable snapshot. */
export interface WebSnapshotDocument {
  kind: "pdf" | "docx" | "xlsx" | "pptx";
  /** Unknown when even the PDF probe failed; the original is still retained. */
  pageCount?: number;
  /** Parser and layout strategy that produced the current text view. */
  parser: string;
  /** The original, immutable material record. Derived analyses point back here. */
  sourceSnapshotId?: string;
  pages?: DocumentPageGeometry[];
  analysis?: DocumentAnalysis;
  ocr?: {
    status: "not-requested" | "not-needed" | "used" | "unavailable";
    engine?: string;
    pages?: number[];
  };
  /** The original bytes are retained separately from the readable text body. */
  source?: {
    contentHash: string;
    byteLength: number;
    contentType: string;
  };
}

export interface WebDocumentRegion {
  /** Normalized 0..1 coordinates on the rotated page, origin at top left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentPageRegion { page: number; region: WebDocumentRegion }

export interface DocumentTableCell {
  text: string;
  row: number;
  column: number;
  rowSpan?: number;
  columnSpan?: number;
  columnHeader?: boolean;
  rowHeader?: boolean;
  rowSection?: boolean;
  regions: DocumentPageRegion[];
}

export interface DocumentStructureBlock {
  id: string;
  kind: "paragraph" | "section" | "table" | "figure" | "formula" | "caption" | "text";
  page: number;
  text: string;
  regions: DocumentPageRegion[];
  startLine?: number;
  endLine?: number;
  analysisId?: string;
}

export interface DocumentStructureElement {
  id: string;
  kind: "section" | "table" | "figure" | "formula";
  page: number;
  regions: DocumentPageRegion[];
  text?: string;
  level?: number;
  captions?: Array<{ id: string; text: string; regions: DocumentPageRegion[] }>;
  cells?: DocumentTableCell[];
  startLine?: number;
  endLine?: number;
  analysisId?: string;
}

export interface DocumentPageGeometry {
  page: number;
  /** Page dimensions in PDF points after rotation. */
  width: number;
  height: number;
  rotation: number;
}

export interface DocumentPageImage {
  page: number;
  mimeType: "image/png";
  data: string;
  byteLength: number;
  width: number;
  height: number;
  /** Hash of the immutable original PDF, independent of text analyses. */
  sourceHash: string;
  region?: WebDocumentRegion;
}

export interface DocumentOverview {
  sourceHash: string;
  sourceSnapshotId: string;
  pageCount?: number;
  pages?: DocumentPageGeometry[];
  textStatus: "not-requested" | "available" | "unavailable";
}

/** Identity and provenance of one immutable derived analysis. */
export interface DocumentAnalysis {
  id: string;
  parser: "native" | "docling";
  version: string;
  configHash?: string;
  toolVersions?: { pdfjs: string; docling?: string; tesseract?: string };
  sourceHash: string;
  pages: number[];
  ocr: boolean;
  status: "ok" | "partial" | "unavailable";
  failedPages?: number[];
}

export interface DocumentFindHit {
  /** Primary page; multi-page parser blocks list all possible pages below. */
  page: number;
  pageCandidates?: number[];
  snippet: string;
  start: number;
  end: number;
  region?: WebDocumentRegion;
}

/** Independent document reading; a Host must resolve and authorize path bytes. */
export interface DocumentReadRequest {
  office?: Omit<import('./office.js').OfficeReadRequest, 'path' | 'snapshotId'>;
  snapshotId?: string;
  path?: string;
  artifact?: { attemptId: string; artifactId: string };
  view?: "overview" | "text" | "page-image" | "structure";
  page?: number;
  /** Explicit `all` reanalyzes the original scope of a partial snapshot. */
  pages?: number[] | "all";
  region?: WebDocumentRegion;
  scale?: number;
  ocr?: boolean;
  parser?: "native" | "docling";
  position?: WebReadPosition;
  find?: string;
}

/** A structural or line-range selector into a fixed snapshot body. */
export type WebReadPosition =
  | { kind: "lines"; startLine: number; endLine?: number }
  | { kind: "page"; page: number }
  | { kind: "section"; title: string }
  | { kind: "element"; element: "table" | "figure" | "formula"; index: number }
  | { kind: "appendix" };

export interface WebSnapshotRef {
  snapshotId: string;
  /** The URL originally requested (pre-redirect). */
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: number;
  /** sha256-… content identity of the stored extracted text. */
  contentHash: string;
  /** Parser that produced the readable view, e.g. "readability-markdown". */
  representation: string;
  byteLength: number;
  contentType?: string;
  rendered?: boolean;
  title?: string;
  structure?: WebSnapshotStructure;
  document?: WebSnapshotDocument;
}

// ---------------------------------------------------------------------------
// Material collections (D-315 L3)
//
// A collection is an explicit set of material references owned by a session
// or thread. Members point at snapshots (fixed bodies), plain URLs (fetched
// and pinned on add), or scholarly paper identities. Members never copy
// content: they reference the existing snapshot/object authority. Searching a
// collection applies the collection scope before recall — only member bodies
// the caller can actually read are scanned.

export type MaterialCollectionMemberKind = "snapshot" | "url" | "paper";

export interface MaterialCollectionMemberInput {
  kind: MaterialCollectionMemberKind;
  snapshotId?: string;
  url?: string;
  /** Scholarly identity entry — metadata only, no body. */
  paper?: { provider: string; id: string; doi?: string; title?: string };
  /** What the material is for this investigation. */
  role?: "main" | "supplement" | "code" | "data" | "other";
  note?: string;
  title?: string;
}

export interface MaterialCollectionMember extends MaterialCollectionMemberInput {
  memberId: string;
  addedAt: number;
}

export interface MaterialCollection {
  collectionId: string;
  name?: string;
  /** Persisted collections survive their owning thread's lifecycle. */
  persisted: boolean;
  createdAt: number;
  updatedAt: number;
  members: MaterialCollectionMember[];
}

export interface MaterialCollectionSummary {
  collectionId: string;
  name?: string;
  persisted: boolean;
  memberCount: number;
  updatedAt: number;
}

export interface MaterialCollectionSearchHit {
  memberId: string;
  snapshotId?: string;
  field: "title" | "source" | "body";
  /** One-based line in the fixed snapshot body. */
  line?: number;
  excerpt: string;
}

export interface MaterialsCollectionParams {
  action: "create" | "add" | "remove" | "list" | "search" | "share";
  collectionId?: string;
  name?: string;
  persist?: boolean;
  member?: MaterialCollectionMemberInput;
  memberId?: string;
  query?: string;
  /** Optional caller-selected hit cap for collection search. */
  limit?: number;
  /** `share`: the related thread that may read the shared material under its
   * own authority. The grant never transfers the sender's receipt or scope. */
  targetThreadId?: string;
  /** `share`: a single snapshot the sender can read, without a collection. */
  snapshotId?: string;
}

/** An explicit material grant: one thread authorizes another related thread
 * to read named snapshots/collections under the receiver's own authority. */
export interface MaterialGrant {
  grantId: string;
  fromThreadId: string;
  toThreadId: string;
  snapshotIds: string[];
  collectionIds: string[];
  createdAt: number;
}

export interface MaterialsCollectionResult {
  status: "ok" | "not-found" | "denied" | "unavailable" | "failed";
  collection?: MaterialCollection;
  collections?: MaterialCollectionSummary[];
  member?: MaterialCollectionMember;
  hits?: MaterialCollectionSearchHit[];
  /** Members whose body could not be read under the caller's authority. */
  unreadable?: string[];
  grant?: MaterialGrant;
  message?: string;
}

export interface WebSearchItem {
  kind: "query" | "objective" | "url" | "page";
  /** Echo of the requested item for correlation. */
  query?: string;
  url?: string;
  status: WebSearchItemStatus;
  /** Query/objective/page items: provider hits. */
  results?: SearchResultItem[];
  /** Opaque continuation token minted only when the provider can paginate. */
  nextCursor?: string;
  /** URL items: the fetch outcome, including its snapshot reference. */
  fetch?: FetchResult;
  /** Human-readable reason for non-ok statuses. */
  detail?: string;
}

export interface WebSearchCapabilities {
  /** The active search provider can continue a result page via cursor. */
  pagination: boolean;
  /** A Host fetch path exists for URL items and snapshot reads. */
  fetch: boolean;
}

export interface WebSearchResult {
  providerId: string;
  capabilities: WebSearchCapabilities;
  items: WebSearchItem[];
  notices?: string[];
}

export interface WebSearchRequest {
  query?: string;
  objective?: string;
  queries?: string[];
  urls?: string[];
  cursor?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
}

export interface WebFetchRequest extends Omit<DocumentReadRequest, "path" | "artifact"> {
  url?: string;
  snapshotId?: string;
  /** Bypass the short-lived response cache and mint a fresh snapshot. */
  refresh?: boolean;
  render?: boolean;
}

// ---------------------------------------------------------------------------
// Pagination cursors
//
// Cursors are opaque to callers and bound to the provider identity plus the
// original constraints (query text, domain policy, recency, limit). A cursor
// minted by one provider cannot be continued on another.

export interface WebSearchCursorPayload {
  v: 1;
  /** Provider id that minted the cursor. */
  p: string;
  /** Original query/objective text. */
  q: string;
  /** Pagination mechanism the provider actually supports. */
  k: "offset" | "page";
  /** Next offset page index or page number, depending on k. */
  n: number;
  allow?: string[];
  block?: string[];
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
}

const CURSOR_PREFIX = "varin-ws1.";

const toBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const fromBase64Url = (value: string): string | null => {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

export const mintSearchCursor = (payload: WebSearchCursorPayload): string => (
  CURSOR_PREFIX + toBase64Url(JSON.stringify(payload))
);

export const parseSearchCursor = (raw: string): WebSearchCursorPayload | null => {
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  const decoded = fromBase64Url(raw.slice(CURSOR_PREFIX.length));
  if (decoded === null) return null;
  try {
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (payload.v !== 1 || typeof payload.p !== "string" || typeof payload.q !== "string") return null;
    if (payload.k !== "offset" && payload.k !== "page") return null;
    if (typeof payload.n !== "number" || !Number.isSafeInteger(payload.n) || payload.n < 0) return null;
    const list = (entry: unknown): string[] | undefined => (
      Array.isArray(entry) && entry.every((item) => typeof item === "string") ? entry as string[] : undefined
    );
    const recency = payload.recency;
    return {
      v: 1,
      p: payload.p,
      q: payload.q,
      k: payload.k,
      n: payload.n,
      ...(payload.allow !== undefined ? { allow: list(payload.allow) ?? [] } : {}),
      ...(payload.block !== undefined ? { block: list(payload.block) ?? [] } : {}),
      ...(recency === "day" || recency === "week" || recency === "month" || recency === "year" ? { recency } : {}),
      ...(typeof payload.limit === "number" && Number.isSafeInteger(payload.limit) && payload.limit > 0
        ? { limit: payload.limit }
        : {}),
    };
  } catch {
    return null;
  }
};
