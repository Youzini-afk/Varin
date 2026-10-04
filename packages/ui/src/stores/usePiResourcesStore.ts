import { create } from 'zustand';
import type {
  PiResourceCatalogSnapshot,
  PiResourceDocumentSnapshot,
  PiResourceKind,
  PiResourceScope,
  RuntimeContextTarget,
} from '@varin/protocol';
import {
  copyPiResource,
  createPiResource,
  deletePiResource,
  getPiResource,
  listPiResources,
  updatePiResource,
} from '@/lib/pi-runtime/resources';
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { getRuntimeKey } from '@varin/application-client';

interface PiResourcePaneState {
  catalog: PiResourceCatalogSnapshot | null;
  document: PiResourceDocumentSnapshot | null;
  draft: string;
  error: string | null;
  loadingCatalog: boolean;
  loadingDocument: boolean;
  mutating: boolean;
  selectedId: string | null;
  targetKey: string | null;
}

interface PiResourcesStore {
  panes: Record<PiResourceKind, PiResourcePaneState>;
  clearError: (kind: PiResourceKind) => void;
  copyResource: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
    scope: PiResourceScope,
    name?: string,
  ) => Promise<boolean>;
  createResource: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
    scope: PiResourceScope,
    name: string,
    content: string,
  ) => Promise<boolean>;
  deleteResource: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
  ) => Promise<boolean>;
  loadCatalog: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
    force?: boolean,
  ) => Promise<void>;
  resetDraft: (kind: PiResourceKind) => void;
  saveResource: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
  ) => Promise<boolean>;
  selectResource: (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
    id: string,
  ) => Promise<void>;
  setDraft: (kind: PiResourceKind, draft: string) => void;
}

const emptyPane = (): PiResourcePaneState => ({
  catalog: null,
  document: null,
  draft: '',
  error: null,
  loadingCatalog: false,
  loadingDocument: false,
  mutating: false,
  selectedId: null,
  targetKey: null,
});

const catalogGeneration: Record<PiResourceKind, number> = { skill: 0 };
const documentGeneration: Record<PiResourceKind, number> = { skill: 0 };
const mutationGeneration: Record<PiResourceKind, number> = { skill: 0 };

const messageForError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const usePiResourcesStore = create<PiResourcesStore>()((set, get) => {
  const updatePane = (
    kind: PiResourceKind,
    updater: (pane: PiResourcePaneState) => PiResourcePaneState,
  ) => set((state) => ({
    panes: {
      ...state.panes,
      [kind]: updater(state.panes[kind]),
    },
  }));

  const replaceFromDocument = async (
    kind: PiResourceKind,
    target: RuntimeContextTarget,
    targetKey: string,
    generation: number,
    runtimeKey: string,
    document: PiResourceDocumentSnapshot,
  ): Promise<boolean> => {
    const catalog = await listPiResources(target, kind);
    if (
      mutationGeneration[kind] !== generation
      || get().panes[kind].targetKey !== targetKey
      || getRuntimeKey() !== runtimeKey
    ) return false;
    updatePane(kind, (pane) => ({
      ...pane,
      catalog,
      document,
      draft: document.content,
      error: null,
      loadingCatalog: false,
      loadingDocument: false,
      mutating: false,
      selectedId: document.descriptor.id,
    }));
    if (kind === 'skill') notifyPiRuntimeCatalogChanged('skill');
    return true;
  };

  return {
    panes: { skill: emptyPane() },

    clearError: (kind) => updatePane(kind, (pane) => ({ ...pane, error: null })),

    loadCatalog: async (kind, target, targetKey, force = false) => {
      const current = get().panes[kind];
      if (
        !force
        && current.targetKey === targetKey
        && (current.loadingCatalog || current.catalog !== null)
      ) return;
      const generation = ++catalogGeneration[kind];
      const runtimeKey = getRuntimeKey();
      ++documentGeneration[kind];
      updatePane(kind, (pane) => ({
        ...(pane.targetKey === targetKey ? pane : emptyPane()),
        error: null,
        loadingCatalog: true,
        targetKey,
      }));
      try {
        const catalog = await listPiResources(target, kind);
        if (
          catalogGeneration[kind] !== generation
          || get().panes[kind].targetKey !== targetKey
          || getRuntimeKey() !== runtimeKey
        ) return;
        const previousId = get().panes[kind].selectedId;
        const selectedId = catalog.resources.some((resource) => resource.id === previousId)
          ? previousId
          : catalog.resources[0]?.id ?? null;
        updatePane(kind, (pane) => ({
          ...pane,
          catalog,
          document: selectedId === pane.document?.descriptor.id ? pane.document : null,
          draft: selectedId === pane.document?.descriptor.id ? pane.draft : '',
          error: null,
          loadingCatalog: false,
          selectedId,
        }));
        if (selectedId && get().panes[kind].document?.descriptor.id !== selectedId) {
          await get().selectResource(kind, target, targetKey, selectedId);
        }
      } catch (error) {
        if (
          catalogGeneration[kind] !== generation
          || get().panes[kind].targetKey !== targetKey
          || getRuntimeKey() !== runtimeKey
        ) return;
        updatePane(kind, (pane) => ({
          ...pane,
          error: messageForError(error),
          loadingCatalog: false,
        }));
      }
    },

    selectResource: async (kind, target, targetKey, id) => {
      const generation = ++documentGeneration[kind];
      const runtimeKey = getRuntimeKey();
      updatePane(kind, (pane) => ({
        ...pane,
        document: pane.document?.descriptor.id === id ? pane.document : null,
        draft: pane.document?.descriptor.id === id ? pane.draft : '',
        error: null,
        loadingDocument: true,
        selectedId: id,
        targetKey,
      }));
      try {
        const document = await getPiResource(target, kind, id);
        if (
          documentGeneration[kind] !== generation
          || get().panes[kind].targetKey !== targetKey
          || get().panes[kind].selectedId !== id
          || getRuntimeKey() !== runtimeKey
        ) return;
        updatePane(kind, (pane) => ({
          ...pane,
          document,
          draft: document.content,
          error: null,
          loadingDocument: false,
        }));
      } catch (error) {
        if (
          documentGeneration[kind] !== generation
          || get().panes[kind].targetKey !== targetKey
          || get().panes[kind].selectedId !== id
          || getRuntimeKey() !== runtimeKey
        ) return;
        updatePane(kind, (pane) => ({
          ...pane,
          error: messageForError(error),
          loadingDocument: false,
        }));
      }
    },

    setDraft: (kind, draft) => updatePane(kind, (pane) => ({ ...pane, draft })),

    resetDraft: (kind) => updatePane(kind, (pane) => ({
      ...pane,
      draft: pane.document?.content ?? '',
      error: null,
    })),

    createResource: async (kind, target, targetKey, scope, name, content) => {
      const generation = ++mutationGeneration[kind];
      const runtimeKey = getRuntimeKey();
      ++catalogGeneration[kind];
      ++documentGeneration[kind];
      updatePane(kind, (pane) => ({ ...pane, error: null, mutating: true, targetKey }));
      try {
        const document = await createPiResource(target, kind, scope, name, content);
        return await replaceFromDocument(kind, target, targetKey, generation, runtimeKey, document);
      } catch (error) {
        if (
          mutationGeneration[kind] === generation
          && get().panes[kind].targetKey === targetKey
          && getRuntimeKey() === runtimeKey
        ) {
          updatePane(kind, (pane) => ({
            ...pane,
            error: messageForError(error),
            mutating: false,
          }));
        }
        return false;
      }
    },

    saveResource: async (kind, target, targetKey) => {
      const pane = get().panes[kind];
      if (!pane.document || pane.document.content === pane.draft || pane.mutating) return false;
      const generation = ++mutationGeneration[kind];
      const runtimeKey = getRuntimeKey();
      ++catalogGeneration[kind];
      ++documentGeneration[kind];
      updatePane(kind, (current) => ({ ...current, error: null, mutating: true }));
      try {
        const document = await updatePiResource(
          target,
          kind,
          pane.document.descriptor.id,
          pane.draft,
          pane.document.revision,
        );
        return await replaceFromDocument(kind, target, targetKey, generation, runtimeKey, document);
      } catch (error) {
        if (
          mutationGeneration[kind] === generation
          && get().panes[kind].targetKey === targetKey
          && getRuntimeKey() === runtimeKey
        ) {
          updatePane(kind, (current) => ({
            ...current,
            error: messageForError(error),
            mutating: false,
          }));
        }
        return false;
      }
    },

    copyResource: async (kind, target, targetKey, scope, name) => {
      const pane = get().panes[kind];
      if (!pane.document || pane.mutating) return false;
      const generation = ++mutationGeneration[kind];
      const runtimeKey = getRuntimeKey();
      ++catalogGeneration[kind];
      ++documentGeneration[kind];
      updatePane(kind, (current) => ({ ...current, error: null, mutating: true }));
      try {
        const document = await copyPiResource(
          target,
          kind,
          pane.document.descriptor.id,
          scope,
          name,
        );
        return await replaceFromDocument(kind, target, targetKey, generation, runtimeKey, document);
      } catch (error) {
        if (
          mutationGeneration[kind] === generation
          && get().panes[kind].targetKey === targetKey
          && getRuntimeKey() === runtimeKey
        ) {
          updatePane(kind, (current) => ({
            ...current,
            error: messageForError(error),
            mutating: false,
          }));
        }
        return false;
      }
    },

    deleteResource: async (kind, target, targetKey) => {
      const pane = get().panes[kind];
      if (!pane.document || pane.mutating) return false;
      const generation = ++mutationGeneration[kind];
      const runtimeKey = getRuntimeKey();
      ++catalogGeneration[kind];
      ++documentGeneration[kind];
      updatePane(kind, (current) => ({ ...current, error: null, mutating: true }));
      try {
        const deletedId = pane.document.descriptor.id;
        await deletePiResource(target, kind, deletedId, pane.document.revision);
        const catalog = await listPiResources(target, kind);
        if (
          mutationGeneration[kind] !== generation
          || get().panes[kind].targetKey !== targetKey
          || getRuntimeKey() !== runtimeKey
        ) return false;
        const nextId = catalog.resources[0]?.id ?? null;
        updatePane(kind, (current) => ({
          ...current,
          catalog,
          document: null,
          draft: '',
          error: null,
          loadingCatalog: false,
          loadingDocument: false,
          mutating: false,
          selectedId: nextId,
        }));
        if (nextId) await get().selectResource(kind, target, targetKey, nextId);
        if (kind === 'skill') notifyPiRuntimeCatalogChanged('skill');
        return true;
      } catch (error) {
        if (
          mutationGeneration[kind] === generation
          && get().panes[kind].targetKey === targetKey
          && getRuntimeKey() === runtimeKey
        ) {
          updatePane(kind, (current) => ({
            ...current,
            error: messageForError(error),
            mutating: false,
          }));
        }
        return false;
      }
    },
  };
});
