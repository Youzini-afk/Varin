import type { DocumentAuthority } from "../documents/authority.js";
import type { VarinLanguageDiagnostic } from "@varin/application-client";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder, type BoundLanguageDocument, type ResolveLanguageTarget } from "../lsp/language-view.js";
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
 * describe the turn's selected code view. Documents are bound on demand and
 * each cache entry keeps the text
 * identity its items were computed from (D-087).
 */
export function createLanguageSupervisorDiagnosticsProvider(
  supervisor: LanguageSupervisor,
  options: {
    documents: Pick<DocumentAuthority, "readSnapshot" | "readAgentInputSnapshot">;
    readSource?: HarnessDocumentReadSource;
    resolveTarget?: ResolveLanguageTarget;
  },
): DiagnosticsProvider {
  const binder = createLanguageViewBinder({ ...options, supervisor, resolveTarget: async input => {
    const target = await options.resolveTarget?.(input) ?? { workspaceId: input.workspaceId, resourceId: input.resourceId };
    ensureSubscription(target.workspaceId);
    return target;
  } });
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
      if (e.kind === 'diagnostics-invalidated') {
        const wsCache = cache.get(workspaceId);
        for (const key of wsCache?.keys() ?? []) if (key.startsWith(`${e.view}\0`)) wsCache?.delete(key);
        return;
      }
      if (e.kind !== "diagnostics" || typeof e.resourceId !== "string") return;
      if (e.view !== AGENT_LANGUAGE_VIEW && !e.view?.startsWith('agent:')) return;
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
      const key = `${e.view}\0${normalizeResourceId(e.resourceId)}`;
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

  const cachedFor = (workspaceId: string, path: string, binding?: BoundLanguageDocument): CachedDiagnostics | null => (
    cache.get(binding?.resource.workspaceId ?? workspaceId)?.get(`${binding?.view ?? AGENT_LANGUAGE_VIEW}\0${normalizeResourceId(binding?.resource.resourceId ?? path)}`) ?? null
  );

  const getDiagnosticsForRevision: DiagnosticsProvider["getDiagnosticsForRevision"] = async (workspaceId, path, revision, binding) => {
    ensureSubscription(workspaceId);
    const cached = cachedFor(workspaceId, path, binding);
    if (!cached || cached.contentRevision !== (binding?.languageRevision ?? revision) || (binding && cached.generation !== binding.generation)) return null;
    return cached.items;
  };

  const bindDocument: DiagnosticsProvider["bindDocument"] = async (workspaceId, path, options = {}) => {
    ensureSubscription(workspaceId);
    const languageId = languageIdForPath(path);
    if (!languageId) return { status: "unsupported" };
    const bound = await binder.bind({ workspaceId, resourceId: path, languageId, text: options.inputContext ? "input-context" : "disk", ...options });
    if (bound.status !== "bound") return { status: "unavailable", message: bound.message };
    ensureSubscription(bound.resource.workspaceId);
    const pulled = await supervisor.pullDiagnostics({
      view: bound.view, resource: bound.resource, languageId, expectedRevision: bound.languageRevision,
      generation: bound.generation, documentVersion: bound.documentVersion,
      expectedViewRevision: bound.viewRevision,
    }, options);
    if (pulled.status === 'ready' && 'value' in pulled && Array.isArray(pulled.value)) {
      const wsCache = cache.get(bound.resource.workspaceId) ?? new Map<string, CachedDiagnostics>();
      cache.set(bound.resource.workspaceId, wsCache);
      const key = `${bound.view}\0${normalizeResourceId(bound.resource.resourceId)}`;
      wsCache.set(key, { generation: bound.generation, contentRevision: bound.languageRevision,
        revision: (wsCache.get(key)?.revision ?? 0) + 1,
        items: (pulled.value as VarinLanguageDiagnostic[]).map(d => ({
          line: d.range.start.line + 1, character: d.range.start.character + 1, severity: d.severity,
          message: d.message, source: d.source ?? 'unknown', ...(d.code === undefined ? {} : { code: String(d.code) }),
        })),
      });
    }
    return { status: "bound", revision: bound.revision, source: bound.source, binding: bound };
  };

  const getSnapshot: DiagnosticsProvider["getSnapshot"] = async (workspaceId, path, binding) => {
    ensureSubscription(workspaceId);
    const cached = cachedFor(workspaceId, path, binding);
    if (!cached) return null;
    return `${cached.generation ?? 0}:${cached.revision}`;
  };

  return {
    getDiagnosticsForRevision,
    bindDocument,
    getSnapshot,
  };
}
