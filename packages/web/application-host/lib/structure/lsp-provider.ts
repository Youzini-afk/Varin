import { languageIdForPath } from "@varin/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import { AGENT_LANGUAGE_VIEW, type createLanguageSupervisor } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import type { HarnessDocumentReadSource } from "../harness/service-host.js";
import { structureKindFromLsp } from "./kinds.js";
import { lspRangeToLines, type LspLikeRange } from "./ranges.js";
import {
  NO_STRUCTURE_CAPABILITIES,
  type StructureCapabilities,
  type StructureClassifyRequest,
  type StructureClassifyResult,
  type StructureImportsResult,
  type StructureLiteralCallsResult,
  type StructureOutlineRequest,
  type StructureOutlineResult,
  type StructureProvider,
  type StructureStatus,
  type StructureSymbol,
} from "./types.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>, "documentSymbols" | "syncDocument" | "getStatus">;

export interface LspStructureProviderOptions {
  documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot">;
  supervisor: LanguageSupervisor;
  readSource?: HarnessDocumentReadSource;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const isLspRange = (value: unknown): value is LspLikeRange => {
  const range = recordOf(value);
  const start = recordOf(range.start);
  const end = recordOf(range.end);
  return [start.line, start.character, end.line, end.character].every((part) => Number.isSafeInteger(part) && Number(part) >= 0);
};

const mapSymbol = (value: unknown): StructureSymbol | null => {
  const raw = recordOf(value);
  if (typeof raw.name !== "string" || !raw.name.trim() || !isLspRange(raw.range)) return null;
  const range = lspRangeToLines(raw.range);
  const signature = isLspRange(raw.selectionRange) ? lspRangeToLines(raw.selectionRange) : {
    startLine: range.startLine,
    endLine: range.startLine,
  };
  const children = Array.isArray(raw.children)
    ? raw.children.map(mapSymbol).filter((child): child is StructureSymbol => child !== null)
    : undefined;
  return {
    name: raw.name.trim(),
    kind: structureKindFromLsp(raw.kind),
    range,
    signature: {
      startLine: Math.max(range.startLine, signature.startLine),
      endLine: Math.min(range.endLine, Math.max(signature.endLine, signature.startLine)),
    },
    ...(children?.length ? { children } : {}),
  };
};

const mapOutlineStatus = (response: Record<string, unknown>, revision: string): StructureStatus => {
  if (response.status === "ready") return "ready";
  if (response.status === "stale") return "stale";
  if (response.status === "absent") return "unavailable";
  if (response.status === "failed" && response.reason === "unsupported") return "unsupported";
  if (response.status === "failed") {
    const message = typeof response.message === "string" ? response.message.toLowerCase() : "";
    if (message.includes("still starting")) return "unavailable";
    return "failed";
  }
  return revision ? "unavailable" : "unavailable";
};

const capabilityFor = (languageId: string | null): StructureCapabilities => (
  languageId
    ? { outline: true, classifyHits: false, literalCalls: false, imports: false }
    : NO_STRUCTURE_CAPABILITIES
);

const unusedCapability = (
  request: StructureOutlineRequest,
  message: string,
): StructureClassifyResult & StructureLiteralCallsResult & StructureImportsResult => ({
  status: "unsupported",
  provider: "lsp",
  revision: request.revision,
  hits: [],
  calls: [],
  imports: [],
  message,
});

/**
 * Structure outline from the Host-owned agent language view.
 * Bind follows the caller's named text identity; explore uses input-context.
 * Cold, missing-capability, and revision mismatch stay distinct statuses.
 */
export function createLspStructureProvider(options: LspStructureProviderOptions): StructureProvider {
  const binder = createLanguageViewBinder({ documents: options.documents, supervisor: options.supervisor, ...(options.readSource ? { readSource: options.readSource } : {}) });

  return {
    id: "lsp",
    capabilities(languageId) {
      return capabilityFor(languageId);
    },
    async outline(request: StructureOutlineRequest): Promise<StructureOutlineResult> {
      if (request.signal?.aborted) {
        return { status: "cancelled", provider: "lsp", revision: request.revision, symbols: [], message: "Structure request was cancelled." };
      }
      const languageId = request.languageId ?? languageIdForPath(request.path);
      if (!languageId) {
        return { status: "unsupported", provider: "lsp", revision: request.revision, symbols: [], message: "No language identity for this path." };
      }
      if (!request.workspaceId) {
        return { status: "unavailable", provider: "lsp", revision: request.revision, symbols: [], message: "Workspace is unavailable for language binding." };
      }
      if (request.warmOnly) {
        const status = options.supervisor.getStatus(request.workspaceId, languageId, AGENT_LANGUAGE_VIEW).status;
        if (status !== "ready" && status !== "degraded") {
          return {
            status: "unavailable",
            provider: "lsp",
            revision: request.revision,
            symbols: [],
            message: "Language server is not already running for this view.",
          };
        }
      }
      const bound = await binder.bind({
        workspaceId: request.workspaceId,
        resourceId: request.path,
        languageId,
        text: "input-context",
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.inputContext ? { inputContext: request.inputContext } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (bound.status !== "bound") {
        return { status: "unavailable", provider: "lsp", revision: request.revision, symbols: [], message: bound.message };
      }
      if (bound.revision !== request.revision) {
        return { status: "stale", provider: "lsp", revision: bound.revision, symbols: [], message: "Bound language text is not the requested revision." };
      }
      if (request.signal?.aborted) {
        return { status: "cancelled", provider: "lsp", revision: request.revision, symbols: [], message: "Structure request was cancelled." };
      }
      const symbolsRequest = {
        view: AGENT_LANGUAGE_VIEW,
        resource: { workspaceId: request.workspaceId, resourceId: request.path },
        languageId,
        expectedRevision: request.revision,
      };
      const response = recordOf(await (request.signal
        ? options.supervisor.documentSymbols(symbolsRequest, { signal: request.signal })
        : options.supervisor.documentSymbols(symbolsRequest)));
      const status = mapOutlineStatus(response, request.revision);
      if (status !== "ready") {
        return {
          status,
          provider: "lsp",
          revision: typeof response.contentRevision === "string" ? response.contentRevision : request.revision,
          symbols: [],
          message: typeof response.message === "string" && response.message
            ? response.message
            : status === "unsupported"
              ? "Language provider does not support document symbols."
              : status === "stale"
                ? "Language symbols are not from the requested revision."
                : status === "unavailable"
                  ? "Language server is not ready for document symbols."
                  : "Language document symbols failed.",
        };
      }
      const symbols = (Array.isArray(response.value) ? response.value : []).map(mapSymbol).filter((symbol): symbol is StructureSymbol => symbol !== null);
      return {
        status: symbols.length > 0 ? "ready" : "empty",
        provider: "lsp",
        revision: request.revision,
        symbols,
      };
    },
    async classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult> {
      return unusedCapability(request, "Hit classification is not available from the language-server outline.");
    },
    async literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult> {
      return unusedCapability(request, "Literal-call extraction is not available from the language-server outline.");
    },
    async imports(request: StructureOutlineRequest): Promise<StructureImportsResult> {
      return unusedCapability(request, "Import extraction is not available from the language-server outline.");
    },
  };
}
