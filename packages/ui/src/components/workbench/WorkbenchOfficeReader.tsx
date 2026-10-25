import React from 'react';
import { getRuntimeEndpointGeneration, getRuntimeUrlResolver, type ThreadIdentity, type ThreadResearchScope } from '@varin/application-client';
import { OfficeMaterialReader, type OfficeFileReaderPort } from '@/components/materials/OfficeMaterialReader';
import type { PdfMaterialReaderPort } from '@/components/materials/PdfMaterialReader';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { appendThreadDraftText } from '@/lib/agent-runtime/threadNavigation';
import { formatPdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorTab } from '@/lib/workbench/editors/types';
import { useI18n } from '@/lib/i18n';

export function WorkbenchOfficeReader({ workspaceId, workspaceRoot, identity, tab, path, revision, onOpenOriginal }: {
  workspaceId: string; workspaceRoot: string; identity?: ThreadIdentity; tab: EditorTab; path: string; revision?: string; onOpenOriginal(): void;
}) {
  const apis = useRuntimeAPIs(), api = apis.threads, host = useThreadStore(state => state.hostKey);
  const { t } = useI18n();
  const [scope, setScope] = React.useState<ThreadResearchScope>();
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    const controller = new AbortController(); setScope(undefined); setError('');
    if (identity && api?.research) void api.research.scopes(identity, controller.signal).then(scopes => {
      // A matching project can have several immutable child revisions. Only a
      // source reading this actual physical directory represents the editor file.
      const normalized = (value: string) => { const path = value.replace(/\\/g, '/').replace(/\/$/, ''); return /^[a-z]:/i.test(path) ? path.toLowerCase() : path; };
      if (!controller.signal.aborted) setScope(scopes.find(scope => scope.workspaceId === workspaceId
        && scope.source.mode !== 'fixed_branch' && scope.source.live_root
        && normalized(scope.source.live_root.canonicalRoot) === normalized(workspaceRoot)));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [api, host, identity, workspaceId, workspaceRoot]);
  const reader = React.useMemo<PdfMaterialReaderPort | OfficeFileReaderPort>(() => {
    const epoch = getRuntimeEndpointGeneration();
    const current = () => epoch === getRuntimeEndpointGeneration() && host === useThreadStore.getState().hostKey;
    if (!identity || !scope) return { key: JSON.stringify([host, workspaceId, path]), isCurrent: current,
      async readOffice(request, signal) {
        if (!apis.files.readOffice || !current()) throw new Error('The original file reader is unavailable');
        return apis.files.readOffice(path, request, { directory: workspaceRoot, signal });
      }, previewUrl: revision => getRuntimeUrlResolver().authenticatedAsset('/api/fs/office', { path, directory: workspaceRoot, expectedRevision: revision, view: 'preview' }),
    };
    return { key: JSON.stringify([host, identity.threadId, identity.branchId, scope.sourceRunId, path]), isCurrent: current,
      async read(request, signal) {
        if (!api || !scope || !current()) throw new Error('The document source is unavailable');
        const { path: _path, artifact: _artifact, snapshotId, ...options } = request;
        return snapshotId ? api.materials.read(identity, { ...options, snapshotId }, signal)
          : api.materials.readSource({ ...identity, sourceRunId: scope.sourceRunId }, { ...options, path }, signal);
      },
    };
  }, [api, apis.files, host, identity, path, scope, workspaceId, workspaceRoot]);
  const state = tab.viewState.providerState;
  const saved = state?.providerId === BUILTIN_EDITOR_PROVIDER_IDS.office && state.value && typeof state.value === 'object' && !Array.isArray(state.value) ? state.value : undefined;
  if (!scope && !apis.files.readOffice) return <div className="space-y-3 p-4 text-sm"><p role={error ? 'alert' : 'status'}>{error || t('office.reader.sourceRequired')}</p><button onClick={onOpenOriginal}>{t('office.reader.openOriginal')}</button></div>;
  return <OfficeMaterialReader reader={reader} title={tab.resourceId.split('/').at(-1) || tab.resourceId} presentation="inline" path={path} refreshKey={revision}
    initialSection={typeof saved?.section === 'string' ? saved.section : undefined} onOpenOriginal={onOpenOriginal}
    onSectionChange={section => patchEditorViewState(workspaceId, tab.viewId, { providerState: { providerId: BUILTIN_EDITOR_PROVIDER_IDS.office, schemaVersion: 1, value: { section } } })}
    onQuote={identity && scope ? quote => {
      if (!reader.isCurrent()) return;
      const href = formatPdfMaterialCitationUrl({ snapshotId: quote.snapshotId, sourceHash: quote.sourceHash, page: 1 })
        + `&format=${quote.format}&section=${encodeURIComponent(quote.section)}&objectId=${encodeURIComponent(quote.objectId)}`;
      appendThreadDraftText(identity, `[${tab.resourceId.replace(/[[\]]/g, '')}](${href})\n${quote.text.split('\n').map(line => `> ${line}`).join('\n')}`);
    } : undefined} />;
}
