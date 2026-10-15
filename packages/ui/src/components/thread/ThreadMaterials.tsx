import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, ThreadRequestError } from '@varin/application-client';
import type { ThreadIdentity, ThreadMaterialsAPI } from '@varin/application-client';
import { PdfMaterialReader, type PdfMaterialDraft, type PdfMaterialReaderPort } from '@/components/materials/PdfMaterialReader';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { formatPdfMaterialCitationUrl, parsePdfMaterialCitationUrl, type PdfMaterialCitation } from '@/lib/materials/pdfMaterialCitation';
import { Button } from '@/components/ui/button';
import { ThreadMaterialDraftContext } from './ThreadMaterialDraftContext';

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
type Material = PdfMaterialCitation & { title: string };

/** Inspect only the Web domain's explicit FetchResult/WebSearchResult fields. Hashes are never authority. */
function threadPdfMaterials(data: unknown): Material[] {
  const result = record(data);
  if (!result) return [];
  const candidates = Array.isArray(result.items) ? result.items.map(item => record(item)?.fetch) : [result];
  const found = new Map<string, Material>();
  for (const candidate of candidates) {
    const fetched = record(candidate);
    if (fetched?.status !== 'ok') continue;
    const snapshot = record(fetched.snapshot);
    const source = record(fetched.sourceSnapshot);
    const selected = record(snapshot?.document)?.kind === 'pdf' ? snapshot : record(source?.document)?.kind === 'pdf' ? source : undefined;
    if (typeof selected?.snapshotId !== 'string' || !selected.snapshotId) continue;
    const document = record(selected.document);
    const hash = record(document?.source)?.contentHash;
    const overview = record(fetched.overview);
    const title = typeof fetched.title === 'string' ? fetched.title : typeof overview?.title === 'string' ? overview.title : typeof fetched.finalUrl === 'string' ? fetched.finalUrl : 'PDF material';
    found.set(selected.snapshotId, { snapshotId: selected.snapshotId, page: 1, title,
      ...(typeof hash === 'string' ? { sourceHash: hash } : {}) });
  }
  return [...found.values()];
}

export function ThreadMaterialLinks({ data }: { data: unknown }) {
  const open = React.useContext(MaterialLinkContext);
  if (!open) return null;
  return <>{threadPdfMaterials(data).map(material => <Button key={material.snapshotId} type="button" variant="outline" size="sm"
    onClick={() => open(formatPdfMaterialCitationUrl(material), material.title)}>Read PDF · {material.title}</Button>)}</>;
}

/** The enclosing Thread supplies identity; global Pi events cannot select or retarget it. */
export function ThreadMaterials({ api, identity, onAddRegion, children }: {
  api: Pick<ThreadMaterialsAPI, 'read'>; identity: ThreadIdentity; onAddRegion?: (region: PdfMaterialDraft) => void; children: React.ReactNode;
}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const owner = React.useMemo(() => ({ api, identity: { runtime: 'agent' as const, threadId: identity.threadId, branchId: identity.branchId }, host, active: true }), [api, identity.threadId, identity.branchId, host]);
  const current = React.useRef(owner); current.current = owner;
  const addRegion = React.useRef(onAddRegion); addRegion.current = onAddRegion;
  const [selected, setSelected] = React.useState<{ owner: typeof owner; material: Material } | null>(null);
  React.useEffect(() => {
    owner.active = host === getRuntimeEndpointGeneration();
    const stop = subscribeRuntimeEndpointWillChange(() => { owner.active = false; setSelected(null); });
    return () => { owner.active = false; stop(); };
  }, [host, owner]);
  const open = React.useCallback((href: string, title: string) => {
    const material = parsePdfMaterialCitationUrl(href);
    if (material && current.current === owner && owner.active && host === getRuntimeEndpointGeneration()) setSelected({ owner, material: { ...material, title: title || 'PDF material' } });
  }, [host, owner]);
  const canAddRegion = Boolean(onAddRegion);
  const reader = React.useMemo<PdfMaterialReaderPort>(() => ({
    key: JSON.stringify([host, identity.threadId, identity.branchId]),
    isCurrent: () => current.current === owner && owner.active && host === getRuntimeEndpointGeneration(),
    async read(request, signal) {
      if (!request.snapshotId || request.path !== undefined || request.artifact !== undefined) throw new Error('Select a retained Thread material');
      try { return await api.read(owner.identity, { ...request, snapshotId: request.snapshotId }, signal); }
      catch (error) {
        if (error instanceof ThreadRequestError) throw new Error(error.status === 403 ? 'Access to this material is denied.'
          : error.status === 404 ? 'This retained material is no longer available.' : `Could not read this material (${error.code}).`);
        throw error;
      }
    },
    ...(canAddRegion ? { addRegion: (region: PdfMaterialDraft) => {
      if (current.current !== owner || !owner.active || host !== getRuntimeEndpointGeneration()) throw new Error('Thread changed');
      addRegion.current?.(region);
    } } : {}),
  }), [api, host, identity.threadId, identity.branchId, owner, canAddRegion]);
  const material = selected?.owner === owner && owner.active ? selected.material : null;
  return <MaterialLinkContext.Provider value={open}>
    <ThreadMaterialDraftContext.Provider value={reader.addRegion ?? null}>
    {children}
    {material && <PdfMaterialReader key={reader.key} reader={reader} title={material.title} snapshotId={material.snapshotId}
      sourceHash={material.sourceHash} initialPage={material.page} initialRegion={material.region} analysisId={material.analysisId}
      onOpenChange={value => { if (!value) setSelected(null); }} />}
    </ThreadMaterialDraftContext.Provider>
  </MaterialLinkContext.Provider>;
}
