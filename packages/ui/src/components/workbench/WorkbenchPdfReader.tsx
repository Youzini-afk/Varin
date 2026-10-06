import React from 'react';
import { PdfMaterialReader, type PdfReaderLocation } from '@/components/pi-session/PdfMaterialReader';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorTab } from '@/lib/workbench/editors/types';

export function WorkbenchPdfReader({ workspaceId, sessionId, tab, path, onOpenOriginal }: {
  workspaceId: string; sessionId: string; tab: EditorTab; path: string; onOpenOriginal(): void;
}) {
  // A mount seed, not live props: saving reading position must not reload the material.
  const [initial] = React.useState<Partial<PdfReaderLocation>>(() => {
    const state = tab.viewState.providerState;
    const value = state?.value;
    if (state?.providerId !== BUILTIN_EDITOR_PROVIDER_IDS.pdf || !value || typeof value !== 'object'
      || Array.isArray(value) || value.sessionId !== sessionId) return {};
    return {
      ...(typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page > 0 ? { page: value.page } : {}),
      ...(value.view === 'page' || value.view === 'text' || value.view === 'structure' ? { view: value.view } : {}),
      ...(typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale > 0 ? { scale: value.scale } : {}),
      ...(typeof value.snapshotId === 'string' ? { snapshotId: value.snapshotId } : {}),
      ...(typeof value.sourceHash === 'string' ? { sourceHash: value.sourceHash } : {}),
    };
  });
  return <PdfMaterialReader presentation="inline" sessionId={sessionId} title={tab.resourceId.split('/').at(-1) || tab.resourceId}
    path={path} snapshotId={initial.snapshotId} sourceHash={initial.sourceHash}
    initialPage={initial.page} initialView={initial.view} initialScale={initial.scale} onOpenOriginal={onOpenOriginal}
    onLocationChange={location => patchEditorViewState(workspaceId, tab.viewId, {
      providerState: { providerId: BUILTIN_EDITOR_PROVIDER_IDS.pdf, schemaVersion: 1, value: { sessionId, ...location } },
    })} />;
}
