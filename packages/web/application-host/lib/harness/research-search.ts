import type {
  ScholarlySearchParams,
  ScholarlyAuthor,
  ScholarlyPaper,
  ScholarlyProvider,
  ScholarlyRelationKind,
  ScholarlySearchResult,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";

type SearchParams = ScholarlySearchParams;

export interface ScholarlySearchContext { signal: AbortSignal }
export interface ScholarlySearchService {
  handle(params: ScholarlySearchParams, context: ScholarlySearchContext): Promise<ScholarlySearchResult>;
}

interface ScholarlySearchDeps {
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_LIMIT = 10;
const OPENALEX = "https://api.openalex.org";
const SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1";
const S2_PAPER_FIELDS = "paperId,title,abstract,year,authors,externalIds,citationCount,url,openAccessPdf";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const abstractFromInvertedIndex = (value: unknown): string | undefined => {
  const inverted = record(value);
  const words: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isSafeInteger(position) && Number(position) >= 0) words.push({ position: Number(position), word });
    }
  }
  if (words.length === 0) return undefined;
  words.sort((left, right) => left.position - right.position);
  return words.map((item) => item.word).join(" ");
};

const authorList = (value: unknown, provider: ScholarlyProvider): ScholarlyAuthor[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const author = provider === "openalex" ? record(row.author) : row;
    const name = text(author.display_name) || text(author.name);
    if (!name) return [];
    const id = text(author.id) || text(author.authorId);
    return [{ name, ...(id ? { id } : {}) }];
  });
};

/** Optional fields a paper record may carry, surfaced as availableFields. */
const OPTIONAL_FIELDS = [
  "abstract",
  "year",
  "authors",
  "doi",
  "externalIds",
  "version",
  "citedByCount",
  "landingUrl",
  "openAccessUrl",
] as const;

const withAvailableFields = (paper: ScholarlyPaper): ScholarlyPaper => ({
  ...paper,
  availableFields: OPTIONAL_FIELDS.filter((field) => {
    const value = paper[field as keyof ScholarlyPaper];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value !== undefined;
  }),
});

const openAlexExternalIds = (value: unknown): Record<string, string> | undefined => {
  const ids = record(value);
  const out: Record<string, string> = {};
  const doi = text(ids.doi).replace(/^https?:\/\/doi\.org\//iu, "");
  if (doi) out.doi = doi;
  for (const [key, name] of [["pmid", "pmid"], ["pmcid", "pmcid"], ["mag", "mag"], ["arxiv", "arxiv"]] as const) {
    const raw = text(ids[key]);
    if (!raw) continue;
    out[name] = raw.replace(/^https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|arxiv\.org\/abs)\//iu, "");
  }
  return Object.keys(out).length ? out : undefined;
};

const openAlexPaper = (value: unknown): ScholarlyPaper | null => {
  const row = record(value);
  const id = text(row.id);
  const title = text(row.title) || text(row.display_name);
  if (!id || !title) return null;
  const primary = record(row.primary_location);
  const landingUrl = text(primary.landing_page_url) || text(row.primary_location);
  const openAccess = record(row.open_access);
  const openAccessUrl = text(primary.pdf_url) || text(openAccess.oa_url) || undefined;
  const externalIds = openAlexExternalIds(row.ids);
  const doi = text(row.doi).replace(/^https?:\/\/doi\.org\//iu, "") || externalIds?.doi;
  const version = text(primary.version) || undefined;
  const year = Number.isSafeInteger(row.publication_year) ? Number(row.publication_year) : undefined;
  const citedByCount = Number.isSafeInteger(row.cited_by_count) ? Number(row.cited_by_count) : undefined;
  const abstract = abstractFromInvertedIndex(row.abstract_inverted_index);
  return withAvailableFields({
    provider: "openalex",
    id,
    title,
    authors: authorList(row.authorships, "openalex"),
    ...(abstract ? { abstract } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(externalIds ? { externalIds } : {}),
    ...(version ? { version } : {}),
    ...(citedByCount !== undefined ? { citedByCount } : {}),
    ...(landingUrl ? { landingUrl } : {}),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    content: openAccessUrl ? "open-location" : "metadata-only",
  });
};

const semanticScholarExternalIds = (value: unknown): Record<string, string> | undefined => {
  const ids = record(value);
  const out: Record<string, string> = {};
  for (const [key, name] of [
    ["DOI", "doi"], ["ArXiv", "arxiv"], ["PubMed", "pmid"], ["PubMedCentral", "pmcid"],
    ["MAG", "mag"], ["CorpusId", "corpusid"],
  ] as const) {
    const raw = ids[key];
    if (typeof raw === "string" && raw.trim()) out[name] = raw.trim();
    else if (typeof raw === "number" && Number.isSafeInteger(raw)) out[name] = String(raw);
  }
  return Object.keys(out).length ? out : undefined;
};

const semanticScholarPaper = (value: unknown): ScholarlyPaper | null => {
  const row = record(value);
  const id = text(row.paperId);
  const title = text(row.title);
  if (!id || !title) return null;
  const externalIds = semanticScholarExternalIds(row.externalIds);
  const openAccessPdf = record(row.openAccessPdf);
  const doi = externalIds?.doi;
  const openAccessUrl = text(openAccessPdf.url) || undefined;
  const year = Number.isSafeInteger(row.year) ? Number(row.year) : undefined;
  const citedByCount = Number.isSafeInteger(row.citationCount) ? Number(row.citationCount) : undefined;
  const abstract = text(row.abstract) || undefined;
  return withAvailableFields({
    provider: "semantic-scholar",
    id,
    title,
    authors: authorList(row.authors, "semantic-scholar"),
    ...(abstract ? { abstract } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(externalIds ? { externalIds } : {}),
    ...(citedByCount !== undefined ? { citedByCount } : {}),
    ...(text(row.url) ? { landingUrl: text(row.url) } : {}),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    content: openAccessUrl ? "open-location" : "metadata-only",
  });
};

const requestJson = async (
  fetcher: typeof globalThis.fetch,
  url: URL,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  signal.throwIfAborted();
  const response = await fetcher(url, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "Varin scholarly search" },
  });
  // Error bodies have no metadata to consume. Await their actual cancellation,
  // including underlying transport cleanup, before reporting that this read stopped.
  if (!response.ok) {
    await response.body?.cancel();
    signal.throwIfAborted();
    throw new Error(`scholarly provider returned HTTP ${response.status}`);
  }
  // The original body must finish (or reject after transport cancellation) before
  // this read can report stopped. Never race an abort.
  const body = await response.text();
  signal.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new Error("scholarly provider returned malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scholarly provider returned malformed JSON");
  return value as Record<string, unknown>;
};

const PROVIDER_CAPABILITIES: Record<ScholarlyProvider, {
  capabilities: Array<"search" | "paper" | "relations" | "open-access-location">;
  relationKinds: ScholarlyRelationKind[];
}> = {
  // OpenAlex embeds referenced/related work ids on the work record and serves
  // citations through a paginated filter — all three edge kinds exist.
  openalex: {
    capabilities: ["search", "paper", "relations", "open-access-location"],
    relationKinds: ["references", "citations", "related"],
  },
  // The graph API exposes references and citations endpoints; it has no
  // related-works endpoint, so `related` is honestly unavailable here.
  "semantic-scholar": {
    capabilities: ["search", "paper", "relations", "open-access-location"],
    relationKinds: ["references", "citations"],
  },
};

const openAlexWorkId = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "openalex.org") return parsed.pathname.replace(/^\//u, "");
  } catch {
    // The provider also accepts its short work id.
  }
  return value;
};

const paperList = (value: unknown, parse: (value: unknown) => ScholarlyPaper | null): ScholarlyPaper[] => {
  if (!Array.isArray(value)) throw new Error("scholarly provider returned a malformed paper list");
  return value.map((item) => {
    const paper = parse(item);
    if (!paper) throw new Error("scholarly provider returned a paper without its identity or title");
    return paper;
  });
};
const singlePaper = (value: unknown, parse: (value: unknown) => ScholarlyPaper | null): ScholarlyPaper[] => paperList([value], parse);
const openAlexCursor = (body: Record<string, unknown>): string | undefined => {
  if (body.meta === undefined) return undefined;
  if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) throw new Error("OpenAlex returned malformed page metadata");
  const next = record(body.meta).next_cursor;
  if (next === undefined || next === null) return undefined;
  if (typeof next !== "string" || !next.trim()) throw new Error("OpenAlex returned a malformed next cursor");
  return next;
};
const semanticScholarCursor = (body: Record<string, unknown>): string | undefined => {
  if (body.next === undefined || body.next === null) return undefined;
  if (!Number.isSafeInteger(body.next) || Number(body.next) < 0) throw new Error("Semantic Scholar returned a malformed next offset");
  return String(body.next);
};
const semanticScholarOffset = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
    throw new HarnessServiceError("invalid-params", "semantic-scholar cursor must be a non-negative safe-integer offset");
  }
  return Number(cursor);
};

const OPENALEX_LIST_CURSOR = /^oa-list:(references|related):([^:]+):(\d+)$/u;

const openAlexIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("OpenAlex returned a malformed relation list");
  return value.map((entry) => {
    const id = text(entry);
    if (!id) throw new Error("OpenAlex returned a relation without a work identity");
    return openAlexWorkId(id);
  });
};

export function createResearchSearchService(deps: ScholarlySearchDeps = {}): ScholarlySearchService {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const capabilitiesOf = (provider: ScholarlyProvider) => PROVIDER_CAPABILITIES[provider];
  const base = (
    provider: ScholarlyProvider,
    action: SearchParams["action"],
    extra: Partial<ScholarlySearchResult> = {},
  ): ScholarlySearchResult => ({
    status: "empty",
    provider,
    action,
    papers: [],
    capabilities: [...capabilitiesOf(provider).capabilities],
    relationKinds: [...capabilitiesOf(provider).relationKinds],
    ...extra,
  });

  const openAlexRelations = async (
    params: SearchParams,
    relation: ScholarlyRelationKind,
    sourceId: string,
    limit: number,
    ctx: ScholarlySearchContext,
  ): Promise<ScholarlySearchResult> => {
    if (relation === "citations") {
      // Server-paginated edge: the provider cursor carries continuation.
      const url = new URL(`${OPENALEX}/works`);
      url.searchParams.set("filter", `cites:${sourceId}`);
      url.searchParams.set("per-page", String(limit));
      url.searchParams.set("cursor", params.cursor ?? "*");
      const body = await requestJson(fetcher, url, ctx.signal);
      const papers = paperList(body.results, openAlexPaper);
      const nextCursor = openAlexCursor(body);
      return base("openalex", "relations", {
        status: papers.length ? "ok" : "empty",
        papers,
        ...(nextCursor ? { nextCursor } : {}),
        relation: { kind: relation, source: { provider: "openalex", id: sourceId } },
      });
    }
    // references / related: the edge list lives on the work record; resolve one
    // page of ids per request. The minted cursor carries the remaining offset.
    let offset = 0;
    if (params.cursor !== undefined) {
      const parsed = OPENALEX_LIST_CURSOR.exec(params.cursor);
      if (!parsed || parsed[1] !== relation || parsed[2] !== encodeURIComponent(sourceId)) {
        throw new HarnessServiceError("invalid-params", "research relations cursor does not match this paper and relation");
      }
      offset = Number(parsed[3]);
      if (!Number.isSafeInteger(offset)) throw new HarnessServiceError("invalid-params", "research relations cursor offset must be a safe integer");
    }
    const work = await requestJson(fetcher, new URL(`${OPENALEX}/works/${encodeURIComponent(sourceId)}`), ctx.signal);
    const sourcePaper = singlePaper(work, openAlexPaper)[0]!;
    const key = relation === "references" ? "referenced_works" : "related_works";
    const ids = openAlexIdList(work[key]);
    const pageIds = ids.slice(offset, offset + limit);
    const source = {
      provider: "openalex" as const,
      id: sourceId,
      ...(sourcePaper.doi ? { doi: sourcePaper.doi } : {}),
      title: sourcePaper.title,
    };
    if (pageIds.length === 0) {
      return base("openalex", "relations", { papers: [], relation: { kind: relation, source } });
    }
    const url = new URL(`${OPENALEX}/works`);
    url.searchParams.set("filter", `ids.openalex:${pageIds.join("|")}`);
    url.searchParams.set("per-page", String(pageIds.length));
    const body = await requestJson(fetcher, url, ctx.signal);
    const papers = paperList(body.results, openAlexPaper);
    const nextOffset = offset + pageIds.length;
    const nextCursor = nextOffset < ids.length ? `oa-list:${relation}:${encodeURIComponent(sourceId)}:${nextOffset}` : undefined;
    return base("openalex", "relations", {
      status: papers.length ? "ok" : "empty",
      papers,
      ...(nextCursor ? { nextCursor } : {}),
      relation: { kind: relation, source },
    });
  };

  const semanticScholarRelations = async (
    params: SearchParams,
    relation: ScholarlyRelationKind,
    sourceId: string,
    limit: number,
    ctx: ScholarlySearchContext,
  ): Promise<ScholarlySearchResult> => {
    if (relation === "related") {
      // The graph API has no related endpoint; recommendations are a different
      // service and are not claimed here.
      return base("semantic-scholar", "relations", {
        status: "unavailable",
        message: "semantic-scholar does not expose a related-works relation",
        relation: { kind: relation, source: { provider: "semantic-scholar", id: sourceId } },
      });
    }
    const offset = semanticScholarOffset(params.cursor);
    const url = new URL(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(sourceId)}/${relation}`);
    url.searchParams.set("fields", S2_PAPER_FIELDS);
    url.searchParams.set("limit", String(limit));
    if (offset > 0) url.searchParams.set("offset", String(offset));
    const body = await requestJson(fetcher, url, ctx.signal);
    const paperKey = relation === "references" ? "citedPaper" : "citingPaper";
    if (!Array.isArray(body.data)) throw new Error("Semantic Scholar returned a malformed relation list");
    // An unresolved edge is explicitly null in the graph API, not a malformed paper.
    const papers = body.data.flatMap((item) => {
      const value = record(item)[paperKey];
      return value === null ? [] : singlePaper(value, semanticScholarPaper);
    });
    const nextOffset = semanticScholarCursor(body);
    return base("semantic-scholar", "relations", {
      status: papers.length ? "ok" : "empty",
      papers,
      ...(nextOffset ? { nextCursor: nextOffset } : {}),
      relation: { kind: relation, source: { provider: "semantic-scholar", id: sourceId } },
    });
  };

  return {
    handle: async (params: SearchParams, ctx: ScholarlySearchContext): Promise<ScholarlySearchResult> => {
      ctx.signal.throwIfAborted();
      const provider = params.provider ?? "openalex";
      if (provider !== "openalex" && provider !== "semantic-scholar") throw new HarnessServiceError("invalid-params", "research search provider must be openalex or semantic-scholar");
      if (!["search", "paper", "relations"].includes(params.action)) throw new HarnessServiceError("invalid-params", "research search action must be search, paper or relations");
      if (params.relation !== undefined && !["references", "citations", "related"].includes(params.relation)) throw new HarnessServiceError("invalid-params", "research relation must be references, citations or related");
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!positiveInteger(limit)) throw new HarnessServiceError("invalid-params", "research search limit must be a positive integer");
      const action = params.action;
      if (action === "search" && !text(params.query)) throw new HarnessServiceError("invalid-params", "research search requires a query");
      if (action !== "search" && !text(params.paperId)) throw new HarnessServiceError("invalid-params", `research ${action} requires paperId`);
      if (action === "relations" && params.relation === undefined) {
        throw new HarnessServiceError("invalid-params", "research relations requires relation: references | citations | related");
      }
      if (action === "relations" && params.relation !== undefined
        && !capabilitiesOf(provider).relationKinds.includes(params.relation)) {
        return base(provider, action, {
          status: "unavailable",
          message: `${provider} does not expose the ${params.relation} relation`,
          relation: { kind: params.relation, source: { provider, id: text(params.paperId) } },
        });
      }
      if (!fetcher) throw new HarnessServiceError("unavailable", "No HTTP client is available for scholarly search");

      try {
        let url: URL;
        if (provider === "openalex") {
          if (action === "relations") {
            return await openAlexRelations(params, params.relation!, openAlexWorkId(text(params.paperId)), limit, ctx);
          }
          if (action === "search") {
            url = new URL(`${OPENALEX}/works`);
            url.searchParams.set("search", text(params.query));
            url.searchParams.set("per-page", String(limit));
            url.searchParams.set("cursor", params.cursor ?? "*");
          } else {
            const paperId = openAlexWorkId(text(params.paperId));
            url = new URL(`${OPENALEX}/works/${encodeURIComponent(paperId)}`);
          }
          const body = await requestJson(fetcher, url, ctx.signal);
          const papers = action === "search" ? paperList(body.results, openAlexPaper) : singlePaper(body, openAlexPaper);
          const nextCursor = action === "search" ? openAlexCursor(body) : undefined;
          return base(provider, action, {
            status: papers.length ? "ok" : "empty",
            papers,
            ...(nextCursor ? { nextCursor } : {}),
          });
        }

        if (action === "relations") {
          return await semanticScholarRelations(params, params.relation!, text(params.paperId), limit, ctx);
        }
        if (action === "search") {
          url = new URL(`${SEMANTIC_SCHOLAR}/paper/search`);
          url.searchParams.set("query", text(params.query));
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("fields", S2_PAPER_FIELDS);
          const offset = semanticScholarOffset(params.cursor);
          if (offset > 0) url.searchParams.set("offset", String(offset));
        } else {
          url = new URL(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(text(params.paperId))}`);
          url.searchParams.set("fields", S2_PAPER_FIELDS);
        }
        const body = await requestJson(fetcher, url, ctx.signal);
        const papers = action === "search" ? paperList(body.data, semanticScholarPaper) : singlePaper(body, semanticScholarPaper);
        const nextOffset = action === "search" ? semanticScholarCursor(body) : undefined;
        return base(provider, action, {
          status: papers.length ? "ok" : "empty",
          papers,
          ...(nextOffset ? { nextCursor: nextOffset } : {}),
        });
      } catch (error) {
        if (ctx.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        // Contract violations (bad cursor, missing params) are caller errors,
        // not provider failures — they must not collapse into a result row.
        if (error instanceof HarnessServiceError) throw error;
        return base(provider, action, {
          status: "failed",
          ...(action === "relations" ? { relation: { kind: params.relation!, source: { provider, id: provider === "openalex" ? openAlexWorkId(text(params.paperId)) : text(params.paperId) } } } : {}),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
