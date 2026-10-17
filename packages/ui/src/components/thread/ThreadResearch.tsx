import React from 'react';
import type { ThreadIdentity, ThreadMaterialsAPI, ThreadResearchAPI, ThreadResearchScope } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useI18n } from '@/lib/i18n';
import { ResearchFactsView } from '@/workbenches/research/ResearchFactsPanel';

/** Source choices are Catalog projections. A later Run changing source never hides the older choice. */
export function ThreadResearch({ api, materials, identity, sourceRunId, onContentChange }: {
  api: ThreadResearchAPI; materials: ThreadMaterialsAPI; identity: ThreadIdentity; sourceRunId?: string; onContentChange?(present: boolean): void;
}) {
  const { t } = useI18n();
  const [scopes, setScopes] = React.useState<ThreadResearchScope[]>([]);
  const [selectedRunId, setSelectedRunId] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const hasContent = scopes.length > 0 || Boolean(error);
  React.useEffect(() => { onContentChange?.(hasContent); }, [hasContent, onContentChange]);
  const generation = React.useRef(0);
  const scopeOwner = React.useRef<{ api: ThreadResearchAPI; threadId: string; branchId: string } | undefined>(undefined);
  React.useEffect(() => {
    let controller: AbortController | undefined;
    let active = true;
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController(); controller = request;
      const current = ++generation.current;
      try {
        const next = await api.scopes({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }, request.signal);
        if (!active || request.signal.aborted || current !== generation.current) return;
        if (!Array.isArray(next) || next.some(scope => !scope.sourceRunId || !scope.workspaceId || !scope.executionWorkspaceId || !scope.source || typeof scope.canSubmit !== 'boolean')) {
          throw new Error('Research source scopes are malformed');
        }
        setScopes(next); setError(undefined);
        setSelectedRunId(previous => next.some(scope => scope.sourceRunId === previous) ? previous
          : next.find(scope => scope.sourceRunId === sourceRunId)?.sourceRunId ?? next[0]?.sourceRunId);
      } catch (failure) {
        if (active && !request.signal.aborted && current === generation.current) {
          setError(failure instanceof Error ? failure.message : 'Research sources are unavailable');
        }
      }
    };
    if (scopeOwner.current?.api !== api || scopeOwner.current.threadId !== identity.threadId || scopeOwner.current.branchId !== identity.branchId) {
      setScopes([]); setSelectedRunId(undefined); setError(undefined);
      scopeOwner.current = { api, threadId: identity.threadId, branchId: identity.branchId };
    }
    void refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || event.type === 'harness-experiment-changed') void refresh();
    });
    return () => { active = false; generation.current += 1; controller?.abort(); unsubscribe(); };
  }, [api, identity.threadId, identity.branchId, sourceRunId]);
  const selected = scopes.find(scope => scope.sourceRunId === selectedRunId);
  const owner = React.useMemo(() => selectedRunId ? {
    api, materials, canSubmit: selected?.canSubmit ?? false,
    selection: { runtime: 'agent' as const, threadId: identity.threadId, branchId: identity.branchId, sourceRunId: selectedRunId },
  } : null, [api, materials, identity.threadId, identity.branchId, selectedRunId, selected?.canSubmit]);
  if (!selected && !error) return null;
  return <section>
    {error && <p role="alert">{error}</p>}
    {scopes.length > 0 && <label className="flex items-center gap-2 text-sm">
      {t('research-facts.source')}
      <select value={selectedRunId ?? ''} onChange={event => setSelectedRunId(event.target.value)}>
        {scopes.map(scope => <option key={scope.sourceRunId} value={scope.sourceRunId}>
          {scope.workspaceId} · {scope.sourceRunId}
        </option>)}
      </select>
    </label>}
    {selected && owner && <ResearchFactsView key={`${identity.threadId}:${identity.branchId}:${selectedRunId}`}
      owner={owner} workspaceId={selected.workspaceId} />}
  </section>;
}
