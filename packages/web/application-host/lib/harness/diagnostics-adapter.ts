import type { DocumentAuthority } from "../documents/authority.js";
import type { VarinLanguageDiagnostic } from "@varin/application-client";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import type { HarnessDocumentReadSource } from "./service-host.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import { languageIdForPath } from "./language-id.js";

type LanguageSupervisor = ReturnType<typeof createLanguageSupervisor>;

interface CachedDiagnostics {
  items: Array<{
    line: number;
    character: number;
    severity: string;
    code?: string;
    message: string;
    source: string;
  }>;
  generation: number | undefined;
  revision: number;
  contentRevision: string | undefined;
}

const normalizeResourceId = (value: string): string => (
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
);

/**
 * Adapts the LanguageSupervisor's event-based diagnostics into the
 * DiagnosticsProvider interface expected by the harness diagnostics service.
 *
 * Only the Host-owned view is consumed: diagnostics reported to an agent must
 * describe the file as written to disk, not whatever text the editor happens to
 * hold. Documents are bound on demand and each cache entry keeps the text
 * identity its items were computed from (D-087).
 */
export function createLanguageSupervisorDiagnosticsProvider(
  supervisor: LanguageSupervisor,
  options: {
    resolveWorkspaceId: (workspaceRoot: string) => Promise<string | null>;
    documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot">;
    readSource?: HarnessDocumentReadSource;
  },
): DiagnosticsProvider {
  const binder = createLanguageViewBinder({ documents: options.documents, supervisor, ...(options.readSource ? { readSource: options.readSource } : {}) });
  // workspaceId → resourceId → cached diagnostics
  const cache = new Map<string, Map<string, CachedDiagnostics>>();
  // workspaceId → subscriptions
  const subscriptions = new Map<string, () => void>();

  const ensureSubscription = (workspaceId: string): void => {
    if (subscriptions.has(workspaceId)) return;
    const sub = supervisor.subscribe(workspaceId, (event: unknown) => {
      const e = event as {
        kind?: string;
        resourceId?: string;
        generation?: number;
        items?: VarinLanguageDiagnostic[];
        view?: string;
        contentRevision?: string;
      };
      if (e.kind !== "diagnostics" || typeof e.resourceId !== "string") return;
      if (e.view !== AGENT_LANGUAGE_VIEW) return;
      let wsCache = cache.get(workspaceId);
      if (!wsCache) {
        wsCache = new Map();
        cache.set(workspaceId, wsCache);
      }
      const items = (e.items ?? []).map((d) => ({
        line: d.range.start.line + 1,
        character: d.range.start.character + 1,
        severity: d.severity,
        ...(d.code !== undefined ? { code: String(d.code) } : {}),
        message: d.message,
        source: d.source ?? "unknown",
      }));
      const key = normalizeResourceId(e.resourceId);
      const previous = wsCache.get(key);
      wsCache.set(key, {
        items,
        generation: e.generation,
        revision: (previous?.revision ?? 0) + 1,
        contentRevision: e.contentRevision,
      });
    });
    subscriptions.set(workspaceId, () => sub.close());
  };

  const cachedFor = (workspaceId: string, path: string): CachedDiagnostics | null => (
    cache.get(workspaceId)?.get(normalizeResourceId(path)) ?? null
  );

  const getDiagnostics: DiagnosticsProvider["getDiagnostics"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    // Exact resource identity only. Suffix matching returned another file's
    // diagnostics whenever one path ended with the other (`src/lib/a.ts` for
    // `a.ts`).
    return cachedFor(workspaceId, path)?.items ?? [];
  };

  const getDiagnosticsForRevision: DiagnosticsProvider["getDiagnosticsForRevision"] = async (workspaceId, path, revision) => {
    ensureSubscription(workspaceId);
    const cached = cachedFor(workspaceId, path);
    if (!cached || cached.contentRevision !== revision) return null;
    return cached.items;
  };

  const bindDocument: DiagnosticsProvider["bindDocument"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    const languageId = languageIdForPath(path);
    if (!languageId) return { status: "unsupported" };
    const bound = await binder.bind({ workspaceId, resourceId: path, languageId, text: "disk" });
    if (bound.status !== "bound") return { status: "unavailable", message: bound.message };
    return { status: "bound", revision: bound.revision, source: bound.source };
  };

  const getSnapshot: DiagnosticsProvider["getSnapshot"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    const cached = cachedFor(workspaceId, path);
    if (!cached) return null;
    return `${cached.generation ?? 0}:${cached.revision}`;
  };

  const isAvailable: DiagnosticsProvider["isAvailable"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    const languageId = languageIdForPath(path);
    if (!languageId) return false;
    // A Host view starts on demand, so availability is a provider question:
    // either view already running for this language proves one exists.
    const agent = supervisor.getStatus(workspaceId, languageId, AGENT_LANGUAGE_VIEW).status;
    if (agent === "ready" || agent === "degraded") return true;
    const bound = await bindDocument(workspaceId, path);
    return bound.status === "bound";
  };

  return {
    getDiagnostics,
    getDiagnosticsForRevision,
    bindDocument,
    getSnapshot,
    isAvailable,
  };
}
