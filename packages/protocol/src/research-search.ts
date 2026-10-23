/**
 * Host-owned scholarly discovery contract (D-315 L2).
 *
 * The result deliberately keeps metadata, an open-access location, and
 * material availability separate. Finding a record is not reading its paper.
 * Relation expansion is on demand and paginated: no whole-graph mirroring.
 */

export type ScholarlyProvider = "openalex" | "semantic-scholar";

export type ScholarlySearchAction = "search" | "paper" | "relations";

/** Edge direction is relative to the requested paper: references are outgoing. */
export type ScholarlyRelationKind = "references" | "citations" | "related";

export interface ScholarlySearchParams {
  action: ScholarlySearchAction;
  provider?: ScholarlyProvider;
  query?: string;
  paperId?: string;
  /** Required when action === "relations". */
  relation?: ScholarlyRelationKind;
  cursor?: string;
  limit?: number;
}

export interface ScholarlyAuthor {
  name: string;
  id?: string;
}

export interface ScholarlyPaper {
  provider: ScholarlyProvider;
  id: string;
  title: string;
  abstract?: string;
  year?: number;
  authors: ScholarlyAuthor[];
  doi?: string;
  /** Trusted cross-provider identifiers (arxiv/pmid/…) when the record carries them. */
  externalIds?: Record<string, string>;
  /** Version marker such as publishedVersion/submittedVersion, when reported. */
  version?: string;
  citedByCount?: number;
  landingUrl?: string;
  openAccessUrl?: string;
  /** Metadata was returned; this does not imply the content was read. */
  content: "metadata-only" | "open-location";
  /** Optional fields actually present in this record, so consumers see gaps. */
  availableFields?: string[];
}

/** The source end of a relations query — the paper the edges hang off. */
export interface ScholarlyRelationSource {
  provider: ScholarlyProvider;
  id: string;
  doi?: string;
  title?: string;
}

export interface ScholarlySearchResult {
  status: "ok" | "empty" | "unavailable" | "failed";
  provider: ScholarlyProvider;
  action: ScholarlySearchAction;
  papers: ScholarlyPaper[];
  /** Present when action === "relations": edge kind and the resolved source. */
  relation?: { kind: ScholarlyRelationKind; source: ScholarlyRelationSource };
  nextCursor?: string;
  capabilities: Array<"search" | "paper" | "relations" | "open-access-location">;
  /** Edge kinds this provider can actually serve. */
  relationKinds?: ScholarlyRelationKind[];
  message?: string;
  code?: string;
  httpStatus?: number;
  retryAfter?: string;
}
