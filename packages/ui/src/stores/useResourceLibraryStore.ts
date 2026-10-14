import { create } from 'zustand';
import { subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { createResourceManagementHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange,
  type NativeResourceCatalogSnapshot, type NativeResourceDocumentSnapshot, type NativeResourceKind,
  type NativeResourceScope, type ResourceManagementTarget } from '@varin/application-client';

interface ResourcePane {
  catalog: NativeResourceCatalogSnapshot | null; document: NativeResourceDocumentSnapshot | null;
  draft: string; error: string | null; loadingCatalog: boolean; loadingDocument: boolean;
  mutating: boolean; selectedId: string | null; targetKey: string | null;
}
interface ResourceLibraryStore {
  panes: Record<NativeResourceKind, ResourcePane>;
  loadCatalog(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string, force?: boolean): Promise<void>;
  selectResource(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string, id: string): Promise<void>;
  createResource(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string, scope: NativeResourceScope, name: string, content: string): Promise<boolean>;
  saveResource(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string): Promise<boolean>;
  copyResource(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string, scope: NativeResourceScope, name?: string): Promise<boolean>;
  deleteResource(kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string): Promise<boolean>;
  setDraft(kind: NativeResourceKind, draft: string): void;
  resetDraft(kind: NativeResourceKind): void;
  clearError(kind: NativeResourceKind): void;
}
const emptyPane = (): ResourcePane => ({ catalog: null, document: null, draft: '', error: null,
  loadingCatalog: false, loadingDocument: false, mutating: false, selectedId: null, targetKey: null });
let catalogGeneration = 0, selectionGeneration = 0;
const mutationKeys = new Map<string, string>();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Configuration library is owned by the native Host; only its admitted, revisioned documents are editable. */
export const useResourceLibraryStore = create<ResourceLibraryStore>((set, get) => {
  const patch = (kind: NativeResourceKind, value: Partial<ResourcePane>) => set(state => ({ panes: { ...state.panes, [kind]: { ...state.panes[kind], ...value } } }));
  const mutate = async (kind: NativeResourceKind, target: ResourceManagementTarget, targetKey: string, verb: 'create' | 'update' | 'copy' | 'remove', input: Record<string, unknown>): Promise<boolean> => {
    const pane = get().panes[kind];
    if (pane.mutating || pane.targetKey !== targetKey || input.scope === 'project' && pane.catalog?.projectTrusted !== true
      || verb !== 'create' && pane.document?.descriptor.sourceInfo.scope === 'project' && pane.catalog?.projectTrusted !== true) return false;
    const host = getRuntimeEndpointGeneration(); const generation = ++selectionGeneration; ++catalogGeneration;
    const api = createResourceManagementHttpAPI(host);
    const current = () => generation === selectionGeneration && host === getRuntimeEndpointGeneration() && get().panes[kind].targetKey === targetKey;
    const fingerprint = JSON.stringify([host, target, verb, input]);
    const key = mutationKeys.get(fingerprint) ?? crypto.randomUUID(); mutationKeys.set(fingerprint, key);
    patch(kind, { targetKey, error: null, mutating: true });
    let confirmed = false;
    try {
      let document: NativeResourceDocumentSnapshot | null;
      if (verb === 'create') document = await api.create(target, { key, scope: input.scope as NativeResourceScope, name: String(input.name), content: String(input.content) });
      else if (verb === 'update') document = await api.update(target, { key, id: String(input.id), content: String(input.content), expectedRevision: String(input.expectedRevision) });
      else if (verb === 'copy') document = await api.copy(target, { key, id: String(input.id), scope: input.scope as NativeResourceScope, name: String(input.name), expectedRevision: String(input.expectedRevision) });
      else { await api.remove(target, { key, id: String(input.id), expectedRevision: String(input.expectedRevision) }); document = null; }
      confirmed = true;
      mutationKeys.delete(fingerprint);
      if (!current()) return false;
      patch(kind, { document, draft: document?.content ?? '', selectedId: document?.descriptor.id ?? null });
      // Refresh through the same generation-bound API, never the currently selected replacement Host.
      const catalog = await api.list(target);
      if (!current()) return false;
      patch(kind, { catalog, document, draft: document?.content ?? '', selectedId: document?.descriptor.id ?? null, mutating: false, loadingCatalog: false, loadingDocument: false, error: null });
      if (!document && catalog.resources[0]) await get().selectResource(kind, target, targetKey, catalog.resources[0].id);
      return true;
    } catch (error) {
      if (current()) patch(kind, { mutating: false, error: errorMessage(error) });
      return confirmed && current();
    }
  };
  return {
    panes: { skill: emptyPane() },
    clearError: kind => patch(kind, { error: null }),
    setDraft: (kind, draft) => patch(kind, { draft }),
    resetDraft: kind => patch(kind, { draft: get().panes[kind].document?.content ?? '', error: null }),
    async loadCatalog(kind, target, targetKey, force = false) {
      const previous = get().panes[kind];
      if (!force && previous.targetKey === targetKey && (previous.loadingCatalog || previous.catalog)) return;
      const generation = ++catalogGeneration; const host = getRuntimeEndpointGeneration(); ++selectionGeneration;
      const current = () => generation === catalogGeneration && host === getRuntimeEndpointGeneration() && get().panes[kind].targetKey === targetKey;
      patch(kind, { ...(previous.targetKey === targetKey ? {} : emptyPane()), targetKey, loadingCatalog: true, error: null });
      try {
        const catalog = await createResourceManagementHttpAPI(host).list(target);
        if (!current()) return;
        const pane = get().panes[kind];
        const dirty = pane.document !== null && pane.draft !== pane.document.content;
        const retained = catalog.resources.find(resource => resource.id === pane.selectedId);
        const selectedId = retained || dirty ? pane.selectedId : catalog.resources[0]?.id ?? null;
        const keepDocument = selectedId !== null && selectedId === pane.document?.descriptor.id;
        const document = keepDocument && pane.document ? { ...pane.document, projectTrusted: catalog.projectTrusted,
          descriptor: { ...pane.document.descriptor, writable: retained?.writable === true } } : null;
        patch(kind, { catalog, loadingCatalog: false, selectedId, ...(keepDocument ? { document } : { document: null, draft: '' }) });
        if (selectedId && !keepDocument) await get().selectResource(kind, target, targetKey, selectedId);
      } catch (error) { if (current()) patch(kind, { error: errorMessage(error), loadingCatalog: false }); }
    },
    async selectResource(kind, target, targetKey, id) {
      const generation = ++selectionGeneration; const host = getRuntimeEndpointGeneration();
      const current = () => generation === selectionGeneration && host === getRuntimeEndpointGeneration() && get().panes[kind].targetKey === targetKey;
      const pane = get().panes[kind];
      patch(kind, { targetKey, selectedId: id, loadingDocument: true, mutating: false, error: null, ...(pane.document?.descriptor.id === id && pane.targetKey === targetKey ? {} : { document: null, draft: '' }) });
      try {
        const document = await createResourceManagementHttpAPI(host).read(target, id);
        if (current()) patch(kind, { document, draft: document.content, loadingDocument: false });
      } catch (error) { if (current()) patch(kind, { error: errorMessage(error), loadingDocument: false }); }
    },
    createResource: (kind, target, targetKey, scope, name, content) => mutate(kind, target, targetKey, 'create', { scope, name, content }),
    saveResource(kind, target, targetKey) {
      const pane = get().panes[kind];
      if (pane.targetKey !== targetKey || !pane.document?.descriptor.writable || pane.document.content === pane.draft) return Promise.resolve(false);
      return mutate(kind, target, targetKey, 'update', { id: pane.document.descriptor.id, content: pane.draft, expectedRevision: pane.document.revision });
    },
    copyResource(kind, target, targetKey, scope, name) {
      if (get().panes[kind].targetKey !== targetKey) return Promise.resolve(false);
      const document = get().panes[kind].document;
      if (!document) return Promise.resolve(false);
      return mutate(kind, target, targetKey, 'copy', { id: document.descriptor.id, expectedRevision: document.revision, scope, name: name ?? `${document.descriptor.name}-copy` });
    },
    deleteResource(kind, target, targetKey) {
      if (get().panes[kind].targetKey !== targetKey) return Promise.resolve(false);
      const document = get().panes[kind].document;
      if (!document?.descriptor.writable) return Promise.resolve(false);
      return mutate(kind, target, targetKey, 'remove', { id: document.descriptor.id, expectedRevision: document.revision });
    },
  };
});
subscribeRuntimeEndpointWillChange(() => {
  catalogGeneration += 1; selectionGeneration += 1;
  useResourceLibraryStore.setState({ panes: { skill: emptyPane() } });
});

// Freeze cached project capabilities immediately; preserve unsaved text while consumers re-read.
subscribeProjectTrustChanges(() => {
  catalogGeneration += 1; selectionGeneration += 1;
  useResourceLibraryStore.setState(state => ({ panes: Object.fromEntries(Object.entries(state.panes).map(([kind, pane]) => [kind, {
    ...pane, catalog: null, loadingCatalog: false, loadingDocument: false, mutating: false,
    document: pane.document ? { ...pane.document, projectTrusted: false, descriptor: { ...pane.document.descriptor, writable: false } } : null,
  }])) as Record<NativeResourceKind, ResourcePane> }));
});
