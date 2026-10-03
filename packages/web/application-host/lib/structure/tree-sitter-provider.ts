import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { languageIdForPath } from "@varin/protocol";
import type { KernelComputeService } from "../kernel/compute-service.js";
import type { KernelComputeResult } from "../kernel/compute-runner.js";
import { STRUCTURE_PARSE_BUDGET_MS } from "./constants.js";
import {
  capabilitiesFromSpec,
  treeSitterLanguageSpec,
  treeSitterTagsSpec,
  type TreeSitterLanguageSpec,
} from "./languages.js";
import { resolveStructureRuntimeFile } from "./runtime-path.js";
import type {
  StructureAnalysis,
  StructureClassifyRequest,
  StructureFileRequest,
  StructureFixedFileRequest,
  StructureHitClass,
  StructureImport,
  StructureLiteralCall,
  StructureOutlineRequest,
  StructureProvider,
  StructureStatus,
  StructureSymbol,
  StructureUnit,
  StructureUnitsResult,
  StructureSourceMetadata,
} from "./types.js";

export interface TreeSitterStructureProviderOptions {
  compute?: Pick<KernelComputeService, "directory" | "text" | "registerGrammar">;
  runtimeFromUrl?: string;
  parseBudgetMs?: number;
  pathExists?: (candidate: string) => boolean;
  onLanguageRequest?: (languageId: string, workspaceId?: string) => void;
  resolveInstalled?: (fileName: string) => string | null;
  resolveInstalledLanguage?: (languageId: string) => { grammarFile: string; tagsQuery: string } | null;
}

const recordOf = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native structure record");
  return value as Record<string, unknown>;
};

const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid native structure line");
  }
  return value;
};

const nonnegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid native structure offset");
  }
  return value;
};

const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid native structure string");
  return value;
};

const grammarIntegrityOf = (file: string): string => (
  `sha256-${createHash("sha256").update(readFileSync(file)).digest("hex")}`
);

const range = (value: unknown) => {
  const record = recordOf(value);
  const startLine = positiveInteger(record.startLine);
  const endLine = positiveInteger(record.endLine);
  if (endLine < startLine) throw new Error("Reversed native structure range");
  return { startLine, endLine };
};

const symbol = (value: unknown): StructureSymbol => {
  const record = recordOf(value);
  return {
    name: string(record.name),
    kind: string(record.kind),
    range: range(record.range),
    signature: range(record.signature),
  };
};

const empty = (revision: string, status: StructureStatus, message: string): StructureAnalysis => {
  const common = { status, provider: "tree-sitter" as const, revision, message };
  return {
    outline: { ...common, symbols: [] },
    classify: { ...common, hits: [] },
    literalCalls: { ...common, calls: [] },
    imports: { ...common, imports: [] },
  };
};

const observedRevision = (
  path: string,
  expectedRevision: string | undefined,
  result: KernelComputeResult,
): string => {
  const revisions = new Set(result.records.filter((record) => record.path === path).map((record) => record.revision));
  if (expectedRevision !== undefined) {
    if ([...revisions].some((revision) => revision !== expectedRevision)) {
      throw new Error("Native structure source identity changed");
    }
    return expectedRevision;
  }
  if (revisions.size > 1) throw new Error("Native disk structure mixed source revisions");
  return revisions.values().next().value ?? "";
};

const captureOf = (path: string, result: KernelComputeResult): { unchanged?: boolean; sourceMetadata?: StructureSourceMetadata } => {
  const frame = result.records.find(record => record.path === path && record.kind === "document"
    && ["captured", "unchanged"].includes(String(recordOf(record.data).status)));
  if (!frame) return {};
  if (result.message || !["ready", "empty"].includes(result.status)) return {};
  const data = recordOf(frame.data);
  const metadata = data.metadata as Partial<StructureSourceMetadata> | null;
  return {
    ...(data.status === "unchanged" ? { unchanged: true } : {}),
    ...(typeof metadata?.byteLength === "string" && typeof metadata.modifiedTimeNs === "string"
      ? { sourceMetadata: { byteLength: metadata.byteLength, modifiedTimeNs: metadata.modifiedTimeNs } } : {}),
  };
};

/** Only shapes and small grammar recipes live here. Text/AST parsing and the
 * cancellable query run in the shared kernel, never a Host parser fallback. */
export function createTreeSitterStructureProvider(options: TreeSitterStructureProviderOptions = {}): StructureProvider {
  const exists = options.pathExists ?? existsSync;
  const grammarHashes = new Map<string, { identity: string; hash: string }>();
  const grammarHashFor = (file: string): string => {
    const info = statSync(file);
    const identity = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const known = grammarHashes.get(file);
    if (known?.identity === identity) return known.hash;
    const hash = grammarIntegrityOf(file);
    grammarHashes.set(file, { identity, hash });
    return hash;
  };
  const specFor = (id: string): TreeSitterLanguageSpec | undefined => {
    const bundled = treeSitterLanguageSpec(id);
    if (bundled) return bundled;
    const installed = options.resolveInstalledLanguage?.(id);
    return installed ? treeSitterTagsSpec(installed.grammarFile, installed.tagsQuery) : undefined;
  };

  const recipeFor = async (request: Pick<StructureOutlineRequest, "languageId" | "path" | "workspaceId">): Promise<string | undefined> => {
    const id = request.languageId ?? languageIdForPath(request.path);
    if (id) options.onLanguageRequest?.(id, request.workspaceId);
    const spec = id ? specFor(id) : undefined;
    if (!spec) return undefined;
    if (spec.tagsOutline === true && !spec.definitionQuery.trim()) {
      throw new Error(`Structure query is not readable for bundled language: ${id}`);
    }
    const grammarPath = resolveStructureRuntimeFile(
      spec.grammarFile,
      options.runtimeFromUrl ?? import.meta.url,
      exists,
      options.resolveInstalled,
    );
    if (!exists(grammarPath)) throw new Error(`Grammar wasm is not readable: ${grammarPath}`);
    if (!options.compute) throw new Error("Native structure computation is unavailable");
    const grammarHash = grammarHashFor(grammarPath);
    // Registration hashes the actual installed bytes. Neither grammar updates
    // nor query recipe changes may reuse a stale compiled language identity.
    return options.compute.registerGrammar({
      recipeId: "",
      grammarPath,
      grammarHash,
      grammarName: "",
      style: spec.jsonOutline ? "json" : spec.tagsOutline ? "tags" : "code",
      definitionQuery: spec.definitionQuery,
      ...(spec.importQuery ? { importQuery: spec.importQuery } : {}),
      ...(spec.literalCallQuery ? { literalCallQuery: spec.literalCallQuery } : {}),
      ...(spec.jsonOutline ? { maxDepth: spec.jsonOutline.maxDepth, maxSymbols: spec.jsonOutline.maxSymbols } : {}),
    });
  };

  const computeText = async (
    request: StructureOutlineRequest,
    operation: "structure" | "chunks",
    lines: number[] = [],
  ) => {
    request.signal?.throwIfAborted();
    const recipeId = await recipeFor(request);
    if (!options.compute) throw new Error("Native structure computation is unavailable");
    if (operation === "structure" && !recipeId) return null;
    const result = await options.compute.text(
      request.workspaceId ?? "structure-input",
      [{ path: "input", revision: request.revision, text: request.text }],
      {
        lane: request.lane ?? "foreground",
        operation,
        includeHidden: true,
        parseBudgetMs: options.parseBudgetMs ?? STRUCTURE_PARSE_BUDGET_MS,
        files: [{ path: "input", revision: request.revision, lines, ...(recipeId ? { recipeId } : {}) }],
      },
      { signal: request.signal },
    );
    return {
      result: {
        ...result,
        records: result.records.map((record) => {
          if (record.path !== "input") throw new Error("Native text computation changed its opaque input identity");
          return { ...record, path: request.path };
        }),
      },
      ...(recipeId ? { recipeId } : {}),
    };
  };

  const computeFile = async (
    request: StructureFileRequest,
    operation: "structure" | "chunks",
  ) => {
    request.signal?.throwIfAborted();
    const recipeId = await recipeFor(request);
    if (!options.compute) throw new Error("Native structure computation is unavailable");
    if (operation === "structure" && !recipeId) return null;
    const result = await options.compute.directory(
      request.root,
      {
        lane: request.lane ?? "background",
        operation,
        includeHidden: true,
        // File visibility is selected by the catalog or caller. An explicit,
        // admitted source read must not apply Git filtering a second time.
        respectGitignore: false,
        paths: [request.path],
        parseBudgetMs: options.parseBudgetMs ?? STRUCTURE_PARSE_BUDGET_MS,
        files: [{ path: request.path, lines: request.lines ?? [], ...(recipeId ? { recipeId } : {}),
          ...(request.unchangedRevision ? { unchangedRevision: request.unchangedRevision } : {}) }],
      },
      { signal: request.signal },
    );
    return { result, ...(recipeId ? { recipeId } : {}) };
  };

  const computeFixed = async (
    request: StructureFixedFileRequest,
    operation: "structure" | "chunks",
  ) => {
    request.signal?.throwIfAborted();
    const recipeId = await recipeFor(request);
    if (operation === "structure" && !recipeId) return null;
    const result = await request.compute({
      lane: request.lane ?? "foreground",
      operation,
      includeHidden: true,
      paths: [request.path],
      parseBudgetMs: options.parseBudgetMs ?? STRUCTURE_PARSE_BUDGET_MS,
      files: [{ path: request.path, lines: request.lines ?? [], ...(recipeId ? { recipeId } : {}) }],
    }, { signal: request.signal });
    return { result, ...(recipeId ? { recipeId } : {}) };
  };

  const decode = (
    path: string,
    expectedRevision: string | undefined,
    result: KernelComputeResult,
    recipeId?: string,
  ): StructureAnalysis => {
    const revision = observedRevision(path, expectedRevision, result);
    const capture = captureOf(path, result);
    if (capture.unchanged) return { ...empty(revision, "empty", ""), ...capture };
    const parts: Record<"symbols" | "hits" | "calls" | "imports", unknown[]> = {
      symbols: [],
      hits: [],
      calls: [],
      imports: [],
    };
    const lineLengths: number[] = [];
    let summary: Record<string, unknown> | undefined;
    for (const nativeRecord of result.records) {
      if (nativeRecord.path !== path) continue;
      if (nativeRecord.revision !== revision) throw new Error("Native structure source identity changed");
      const data = recordOf(nativeRecord.data);
      if (nativeRecord.kind === "structure-part") {
        if (typeof data.category !== "string" || !Array.isArray(data.items)) {
          throw new Error("Invalid native structure batch");
        }
        if (data.category === "lineLengths") {
          const offset = nonnegativeInteger(data.offset);
          if (offset !== lineLengths.length) throw new Error("Native line-length batch is not contiguous");
          for (const item of data.items) lineLengths.push(nonnegativeInteger(item));
        } else if (data.category in parts) {
          parts[data.category as keyof typeof parts].push(...data.items);
        }
      } else if (nativeRecord.kind === "structure") {
        summary = data;
      }
    }
    if (!summary) {
      return empty(
        revision,
        result.status === "cancelled" ? "cancelled" : "failed",
        result.message ?? "Native structure did not complete",
      );
    }
    const status = summary.status;
    if (status !== "ready" && status !== "empty") {
      const failure: StructureStatus = ["stale", "failed", "unavailable", "unsupported", "cancelled"].includes(String(status))
        ? status as StructureStatus
        : "failed";
      return empty(
        revision,
        failure,
        typeof summary.message === "string" ? summary.message : "Native structure failed",
      );
    }
    const common = { provider: "tree-sitter" as const, revision };
    const symbols = parts.symbols.map(symbol);
    const hits = parts.hits.map((value) => {
      const hit = recordOf(value);
      if (!["name", "body", "comment", "string"].includes(String(hit.class))) {
        throw new Error("Invalid native hit class");
      }
      return { line: positiveInteger(hit.line), class: hit.class as StructureHitClass };
    });
    const calls: StructureLiteralCall[] = parts.calls.map((value) => {
      const call = recordOf(value);
      return { name: string(call.name), literal: string(call.literal), line: positiveInteger(call.line) };
    });
    const imports: StructureImport[] = parts.imports.map((value) => {
      const item = recordOf(value);
      return { source: string(item.source), line: positiveInteger(item.line) };
    });
    return {
      outline: { ...common, status: symbols.length ? "ready" : "empty", symbols },
      classify: { ...common, status: "ready", hits },
      literalCalls: { ...common, status: summary.callsStatus === "unsupported" ? "unsupported" : "ready", calls },
      imports: { ...common, status: summary.importsStatus === "unsupported" ? "unsupported" : "ready", imports },
      lineLengths,
      ...capture,
      ...(recipeId ? { recipeId } : {}),
    };
  };

  const decodeUnits = (
    path: string,
    expectedRevision: string | undefined,
    run: { result: KernelComputeResult; recipeId?: string },
  ): StructureUnitsResult => {
    const revision = observedRevision(path, expectedRevision, run.result);
    const capture = captureOf(path, run.result);
    if (capture.unchanged) return { status: "empty", revision, units: [], ...capture };
    const units: StructureUnit[] = [];
    let pending: StructureUnit | undefined;
    let offset = 0;
    for (const nativeRecord of run.result.records) {
      if (nativeRecord.kind !== "unit" || nativeRecord.path !== path) continue;
      if (nativeRecord.revision !== revision) throw new Error("Native chunk source identity changed");
      const data = recordOf(nativeRecord.data);
      if (data.offset === 0) {
        if (pending) throw new Error("Incomplete native unit");
        pending = {
          ...range(data),
          parentName: string(data.parentName),
          parentKind: string(data.parentKind),
          parentSignature: string(data.parentSignature),
          docComments: string(data.docComments),
          text: "",
          fallback: data.fallback === true,
        };
        offset = 0;
      }
      if (!pending || data.offset !== offset) throw new Error("Native unit byte continuation mismatch");
      const text = string(data.text);
      pending.text += text;
      offset += Buffer.byteLength(text, "utf8");
      if (data.final === true) {
        units.push(pending);
        pending = undefined;
      }
    }
    if (pending) throw new Error("Native unit ended before its final frame");
    if (["failed", "partial", "cancelled"].includes(run.result.status) || run.result.message) {
      throw new Error(run.result.message ?? "Native unit production failed");
    }
    return {
      status: units.length ? "ready" : "empty",
      revision,
      units,
      ...capture,
      ...(run.recipeId ? { recipeId: run.recipeId } : {}),
    };
  };

  const analyze = async (request: StructureClassifyRequest): Promise<StructureAnalysis> => {
    try {
      const run = await computeText(request, "structure", request.lines);
      return run
        ? decode(request.path, request.revision, run.result, run.recipeId)
        : empty(request.revision, "unsupported", "tree-sitter has no grammar spec for this language.");
    } catch (error) {
      return empty(
        request.revision,
        request.signal?.aborted ? "cancelled" : "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const analyzeFile = async (request: StructureFileRequest): Promise<StructureAnalysis> => {
    try {
      const run = await computeFile(request, "structure");
      return run
        ? decode(request.path, undefined, run.result, run.recipeId)
        : empty("", "unsupported", "tree-sitter has no grammar spec for this language.");
    } catch (error) {
      return empty(
        "",
        request.signal?.aborted ? "cancelled" : "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return {
    id: "tree-sitter",
    capabilities: (id) => capabilitiesFromSpec(id ? specFor(id) : undefined),
    analyze,
    analyzeFile,
    outline: async (request) => (await analyze({ ...request, lines: request.hitLines ?? [] })).outline,
    classifyHits: async (request) => (await analyze(request)).classify,
    literalCalls: async (request) => (await analyze({ ...request, lines: [] })).literalCalls,
    imports: async (request) => (await analyze({ ...request, lines: [] })).imports,
    async units(request): Promise<StructureUnitsResult> {
      try {
        const run = await computeText(request, "chunks");
        if (!run) throw new Error("Native structural units unavailable");
        return decodeUnits(request.path, request.revision, run);
      } catch (error) {
        return {
          status: request.signal?.aborted ? "cancelled" : "failed",
          revision: request.revision,
          units: [],
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async unitsFile(request): Promise<StructureUnitsResult> {
      try {
        const run = await computeFile(request, "chunks");
        if (!run) throw new Error("Native structural units unavailable");
        return decodeUnits(request.path, undefined, run);
      } catch (error) {
        return {
          status: request.signal?.aborted ? "cancelled" : "failed",
          revision: "",
          units: [],
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async unitsFixed(request): Promise<StructureUnitsResult> {
      try {
        const run = await computeFixed(request, "chunks");
        if (!run) throw new Error("Native fixed-view structural units unavailable");
        return decodeUnits(request.path, undefined, run);
      } catch (error) {
        return {
          status: request.signal?.aborted ? "cancelled" : "failed",
          revision: "",
          units: [],
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
