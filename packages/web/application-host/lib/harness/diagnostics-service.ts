import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { DiagnosticItem, LanguageTextProvenance } from "@varin/protocol";
import type { ObservationCursorStore } from "./observation-cursors.js";
import { setTimeout as delay } from "node:timers/promises";
import type { BoundLanguageDocument } from "../lsp/language-view.js";

export type BindDocumentResult =
  | { status: "bound"; revision: string; source: LanguageTextProvenance; binding?: BoundLanguageDocument }
  | { status: "unavailable"; message: string }
  | { status: "unsupported" };

export interface DiagnosticsProvider {
  /**
   * Bind the path in the Host language view to the caller's selected text and report
   * the revision the answer will describe (D-087).
   */
  bindDocument(workspaceId: string, path: string, options?: Partial<Pick<HarnessServiceContext, 'signal' | 'reportPhase' | 'sessionId' | 'inputContext'>>): Promise<BindDocumentResult>;
  /**
   * Diagnostics the language server published for exactly this text identity,
   * or null while it has not answered for that revision yet.
   */
  getDiagnosticsForRevision(workspaceId: string, path: string, revision: string, binding?: BoundLanguageDocument): Promise<DiagnosticItem[] | null>;
  getSnapshot(workspaceId: string, path: string, binding?: BoundLanguageDocument): Promise<string | null>;
}

/**
 * Diagnostics service semantics (D-087):
 * - No language server for this file type → unavailable.
 * - Otherwise the path is bound in the Host language view to the caller's
 *   selected text (disk, fixed draft, or materialized child workspace), and the
 *   answer waits for the publication computed from that exact revision, up to
 *   waitMs (default 5000). An authoritative empty list is a clean result.
 * - No publication for that revision within waitMs → pending.
 */
export function createLspDiagnosticsService(provider: DiagnosticsProvider): HarnessService<"lsp.diagnostics"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const providerWorkspaceId = ctx.authorizedPaths[0]?.workspaceId ?? ctx.workspaceId;
      if (!providerWorkspaceId) {
        return { status: "unavailable", diagnostics: [], reason: "no workspace" };
      }
      try {
        // The provider keys documents by workspace-relative resource id —
        // authorizedPaths already reduced absolute/operation-dir-anchored
        // inputs to that form (RR4/E08).
        const resourcePath = ctx.authorizedPaths[0]?.resourceId ?? params.path;
        const bound = await provider.bindDocument(providerWorkspaceId, resourcePath, ctx);
        if (bound.status === "unsupported") {
          return { status: "unavailable", diagnostics: [], reason: "no language server for this file type" };
        }
        if (bound.status === "unavailable") {
          return { status: "unavailable", diagnostics: [], reason: bound.message };
        }
        const waitMs = params.waitMs ?? 5000;
        const deadline = Date.now() + waitMs;
        ctx.reportPhase?.('lsp:diagnostics-publication');
        for (;;) {
          ctx.signal.throwIfAborted();
          const diagnostics = await provider.getDiagnosticsForRevision(providerWorkspaceId, resourcePath, bound.revision, bound.binding);
          if (diagnostics) {
            const snapshot = await provider.getSnapshot(providerWorkspaceId, resourcePath, bound.binding);
            return {
              status: "ready",
              ...(snapshot !== null ? { snapshot } : {}),
              revision: bound.revision,
              source: bound.source,
              diagnostics,
            };
          }
          if (Date.now() >= deadline) {
            return {
              status: "pending",
              diagnostics: [],
              revision: bound.revision,
              source: bound.source,
              reason: "diagnostics not yet published for this revision",
            };
          }
          await delay(50, undefined, { signal: ctx.signal });
        }
      } catch {
        ctx.signal.throwIfAborted();
        return { status: "unavailable", diagnostics: [], reason: "diagnostics request failed" };
      }
    },
  };
}

interface DiagnosticsCursor {
  diagnostics: DiagnosticItem[];
}

const diagnosticFingerprint = (diagnostic: DiagnosticItem): string => JSON.stringify([
  diagnostic.line,
  diagnostic.character,
  diagnostic.severity,
  diagnostic.code ?? null,
  diagnostic.message,
  diagnostic.source,
]);

const subtractDiagnostics = (left: readonly DiagnosticItem[], right: readonly DiagnosticItem[]): DiagnosticItem[] => {
  const remaining = new Map<string, number>();
  for (const diagnostic of right) {
    const key = diagnosticFingerprint(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return left.filter((diagnostic) => {
    const key = diagnosticFingerprint(diagnostic);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
    return false;
  });
};

export function createLspDiagnosticsSnapshotService(
  provider: DiagnosticsProvider,
  cursors: ObservationCursorStore,
): HarnessService<"lsp.diagnosticsSnapshot"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const providerWorkspaceId = ctx.authorizedPaths[0]?.workspaceId ?? ctx.workspaceId;
      if (!providerWorkspaceId) {
        return { status: "unavailable", diagnostics: [], reason: "no workspace" };
      }
      // Binding both starts the Host view on demand and reports the text the
      // observation describes. Missing publications remain pending.
      // The provider keys documents by workspace-relative resource id.
      const resourcePath = ctx.authorizedPaths[0]?.resourceId ?? params.path;
      const bound = await provider.bindDocument(providerWorkspaceId, resourcePath, ctx);
      if (bound.status === "unsupported") {
        return { status: "unavailable", diagnostics: [], reason: "no language server for this file type" };
      }
      if (bound.status === "unavailable") {
        return { status: "unavailable", diagnostics: [], reason: bound.message };
      }
      const provenance = { revision: bound.revision, source: bound.source };
      try {
        const diagnostics = await provider.getDiagnosticsForRevision(providerWorkspaceId, resourcePath, bound.revision, bound.binding);
        if (diagnostics === null) return { status: 'pending', diagnostics: [], ...provenance,
          reason: 'diagnostics not yet published for this revision' };
        const snapshot = await provider.getSnapshot(providerWorkspaceId, resourcePath, bound.binding);
        if (params.full === true) {
          return {
            status: "ready",
            ...(snapshot !== null ? { snapshot } : {}),
            ...provenance,
            diagnostics,
          };
        }
        const canonicalResourceId = ctx.authorizedPaths[0]?.canonicalResourceId ?? params.path;
        // HR0: provider calls are addressed by the authorized resource root,
        // not the actor's session classification (which may be null for an
        // unbound session reading an external file).
        const resourceWorkspaceId = ctx.authorizedPaths[0]?.workspaceId ?? ctx.workspaceId!;
        const objectId = `${resourceWorkspaceId}\0${canonicalResourceId}\0${bound.binding?.view ?? 'agent'}`;
        const pending = await cursors.prepare<DiagnosticsCursor, import("@varin/protocol").DiagnosticsResult>(
          ctx.sessionId,
          "diagnostics",
          objectId,
          async (previous) => {
            const added = previous === null
              ? diagnostics
              : subtractDiagnostics(diagnostics, previous.value.diagnostics);
            const resolved = previous === null
              ? []
              : subtractDiagnostics(previous.value.diagnostics, diagnostics);
            const now = cursors.now();
            return {
              cursor: { diagnostics },
              result: {
                status: "ready",
                ...(snapshot !== null ? { snapshot } : {}),
                ...provenance,
                diagnostics: added,
                resolvedDiagnostics: resolved,
                observation: {
                  mode: "incremental",
                  first: previous === null,
                  ...(previous === null ? {} : { sinceMs: Math.max(0, now - previous.observedAt) }),
                  added: added.length,
                  resolved: resolved.length,
                },
              },
            };
          },
        );
        if (ctx.deferResponseDelivery) ctx.deferResponseDelivery(pending.commit, pending.abort);
        else pending.commit();
        return { ...pending.result, observationRef: pending.observationRef };
      } catch {
        ctx.signal.throwIfAborted();
        return { status: "unavailable", diagnostics: [], reason: "diagnostics request failed" };
      }
    },
  };
}
