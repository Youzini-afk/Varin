import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadResearchScope } from '@varin/application-client';
import { PdfMaterialReader, type PdfReaderLocation, type PdfMaterialReaderPort } from '@/components/materials/PdfMaterialReader';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorTab } from '@/lib/workbench/editors/types';
import { appendThreadDraftText } from '@/lib/agent-runtime/threadNavigation';
import { buildPdfMaterialCitationMarkdown } from '@/lib/materials/pdfMaterialCitation';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadIdentityKey, useThreadStore } from '@/stores/useThreadStore';

/** The original source Run admits local PDF access; navigation paths confer no authority. */
export function WorkbenchPdfReader({ workspaceId, identity, tab, path, onOpenOriginal }: {
  workspaceId: string; identity: ThreadIdentity; tab: EditorTab; path: string; onOpenOriginal(): void;
}) {
  const api = useRuntimeAPIs().threads;
  const [scopes, setScopes] = React.useState<ThreadResearchScope[]>([]);
  const [runId, setRunId] = React.useState('');
  const [error, setError] = React.useState('');
  const host = useThreadStore(state => state.hostKey);
  React.useEffect(() => {
    const controller = new AbortController(); setScopes([]); setRunId(''); setError('');
    if (!api?.research) { setError('PDF source inspection is unavailable'); return; }
    void api.research.scopes(identity, controller.signal).then(all => {
      if (controller.signal.aborted) return;
      const matching = all.filter(scope => scope.workspaceId === workspaceId);
      setScopes(matching); setRunId(matching[0]?.sourceRunId ?? '');
    }, cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [api, host, identity, workspaceId]);
  const scope = scopes.find(value => value.sourceRunId === runId);
  const [initial] = React.useState<Partial<PdfReaderLocation>>(() => {
    const saved = tab.viewState.providerState;
    const value = saved?.value;
    if (saved?.providerId !== BUILTIN_EDITOR_PROVIDER_IDS.pdf || !value || typeof value !== 'object' || Array.isArray(value)
      || value.threadId !== identity.threadId || value.branchId !== identity.branchId) return {};
    return { ...(typeof value.page === 'number' ? { page: value.page } : {}), ...(value.view === 'page' || value.view === 'text' || value.view === 'structure' ? { view: value.view } : {}), ...(typeof value.scale === 'number' ? { scale: value.scale } : {}) };
  });
  const reader = React.useMemo<PdfMaterialReaderPort>(() => {
    const epoch = getRuntimeEndpointGeneration();
    const selection = { ...identity, sourceRunId: runId };
    const isCurrent = () => host === useThreadStore.getState().hostKey && epoch === getRuntimeEndpointGeneration();
    return { key: JSON.stringify([host, identity.threadId, identity.branchId, runId, path]), isCurrent,
      async read(request, signal) {
        if (!api || !scope || !isCurrent()) throw new Error('The original PDF source is unavailable');
        const { path: _path, artifact: _artifact, snapshotId, ...options } = request;
        if (snapshotId) return api.materials.read(identity, { ...options, snapshotId }, signal);
        return api.materials.readSource(selection, { ...options, path }, signal);
      },
      addRegion(region) {
        if (!isCurrent()) throw new Error('Application Host changed');
        const key = threadIdentityKey(host, identity);
        useThreadDraftStore.getState().patch(key, draft => ({ images: [...draft.images, region.image] }));
        appendThreadDraftText(identity, buildPdfMaterialCitationMarkdown(region.title, region));
      },
    };
  }, [api, host, identity, path, runId, scope]);
  if (!scope) return <div className="space-y-2 p-3 text-sm"><p role={error ? 'alert' : 'status'}>{error || 'Select a conversation with an admitted source for this workspace to inspect PDF pages and regions.'}</p><button onClick={onOpenOriginal}>Open original PDF</button></div>;
  return <div className="flex h-full min-h-0 flex-col">
    {scopes.length > 1 && <select aria-label="PDF source Run" value={runId} onChange={event => setRunId(event.target.value)}>{scopes.map(item => <option key={item.sourceRunId}>{item.sourceRunId}</option>)}</select>}
    <PdfMaterialReader key={reader.key} presentation="inline" reader={reader} title={tab.resourceId.split('/').at(-1) || tab.resourceId}
      path={path} initialPage={initial.page} initialView={initial.view} initialScale={initial.scale} onOpenOriginal={onOpenOriginal}
      onLocationChange={location => patchEditorViewState(workspaceId, tab.viewId, { providerState: { providerId: BUILTIN_EDITOR_PROVIDER_IDS.pdf, schemaVersion: 1, value: { threadId: identity.threadId, branchId: identity.branchId, sourceRunId: runId, ...location } } })} />
  </div>;
}
