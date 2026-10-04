import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  PiResourceCatalogSnapshot,
  PiResourceDescriptor,
  PiResourceDocumentSnapshot,
  PiResourceKind,
  PiResourceScope,
  RuntimeContextTarget,
} from '@varin/protocol';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';

let runtimeKey = 'runtime-a';
let listImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
) => Promise<PiResourceCatalogSnapshot>;
let getImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
) => Promise<PiResourceDocumentSnapshot>;
let createImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  scope: PiResourceScope,
  name: string,
  content: string,
) => Promise<PiResourceDocumentSnapshot>;
let updateImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  content: string,
  expectedRevision: string,
) => Promise<PiResourceDocumentSnapshot>;
let deleteImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  expectedRevision: string,
) => Promise<unknown>;
let copyImpl: (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  scope: PiResourceScope,
  name?: string,
) => Promise<PiResourceDocumentSnapshot>;

vi.doMock('@varin/application-client', () => ({ getRuntimeKey: () => runtimeKey }));
vi.doMock('@/lib/pi-runtime/resources', () => ({
  listPiResources: (...args: Parameters<typeof listImpl>) => listImpl(...args),
  getPiResource: (...args: Parameters<typeof getImpl>) => getImpl(...args),
  createPiResource: (...args: Parameters<typeof createImpl>) => createImpl(...args),
  updatePiResource: (...args: Parameters<typeof updateImpl>) => updateImpl(...args),
  deletePiResource: (...args: Parameters<typeof deleteImpl>) => deleteImpl(...args),
  copyPiResource: (...args: Parameters<typeof copyImpl>) => copyImpl(...args),
}));

const { usePiResourcesStore } = await import('./usePiResourcesStore');

const target: RuntimeContextTarget = { cwd: 'C:/workspace/project' };
const targetKey = 'runtime-a:project';

const descriptor = (
  id: string,
  overrides: Partial<PiResourceDescriptor> = {},
): PiResourceDescriptor => ({
  active: true,
  description: '',
  filePath: `C:/agent/prompts/${id}.md`,
  id,
  kind: 'skill',
  name: id,
  sourceInfo: {
    origin: 'top-level',
    path: `C:/agent/prompts/${id}.md`,
    scope: 'user',
    source: 'user',
  },
  valid: true,
  writable: true,
  ...overrides,
});

const document = (
  id: string,
  content = `# ${id}`,
  revision = `revision-${id}`,
  overrides: Partial<PiResourceDescriptor> = {},
): PiResourceDocumentSnapshot => ({
  content,
  descriptor: descriptor(id, overrides),
  projectTrusted: true,
  revision,
});

const catalog = (...resources: PiResourceDescriptor[]): PiResourceCatalogSnapshot => ({
  diagnostics: [],
  projectTrusted: true,
  resources,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const emptyPane = () => ({
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

describe('usePiResourcesStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    const first = document('review');
    listImpl = async () => catalog(first.descriptor);
    getImpl = async (_target, _kind, id) => (
      id === first.descriptor.id ? first : document(id)
    );
    createImpl = async (_target, _kind, _scope, name, content) => document(name, content);
    updateImpl = async (_target, _kind, id, content) => document(id, content, 'revision-updated');
    deleteImpl = async () => ({ deleted: true });
    copyImpl = async (_target, _kind, _id, _scope, name) => document(name ?? 'review-copy');
    usePiResourcesStore.setState({
      panes: { skill: emptyPane() },
    });
  });

  test('loads a catalog and selects the first native resource document', async () => {
    await usePiResourcesStore.getState().loadCatalog('skill', target, targetKey);

    const pane = usePiResourcesStore.getState().panes.skill;
    expect(pane.selectedId).toBe('review');
    expect(pane.document?.content).toBe('# review');
    expect(pane.draft).toBe('# review');
    expect(pane.loadingCatalog).toBe(false);
    expect(pane.loadingDocument).toBe(false);
  });

  test('commits a draft with the loaded revision and adopts the returned revision', async () => {
    let receivedRevision: string | null = null;
    updateImpl = async (_target, _kind, id, content, expectedRevision) => {
      receivedRevision = expectedRevision;
      return document(id, content, 'revision-2');
    };
    await usePiResourcesStore.getState().loadCatalog('skill', target, targetKey);
    usePiResourcesStore.getState().setDraft('skill', '# edited');

    const saved = await usePiResourcesStore.getState().saveResource('skill', target, targetKey);

    const pane = usePiResourcesStore.getState().panes.skill;
    expect(saved).toBe(true);
    expect(receivedRevision).toBe('revision-review');
    expect(pane.document?.revision).toBe('revision-2');
    expect(pane.document?.content).toBe('# edited');
    expect(pane.draft).toBe('# edited');
  });

  test('preserves the edited draft when revision conflict rejects a save', async () => {
    updateImpl = async () => { throw new Error('resource_conflict'); };
    await usePiResourcesStore.getState().loadCatalog('skill', target, targetKey);
    usePiResourcesStore.getState().setDraft('skill', '# local edit');

    const saved = await usePiResourcesStore.getState().saveResource('skill', target, targetKey);

    const pane = usePiResourcesStore.getState().panes.skill;
    expect(saved).toBe(false);
    expect(pane.document?.content).toBe('# review');
    expect(pane.draft).toBe('# local edit');
    expect(pane.error).toBe('resource_conflict');
    expect(pane.mutating).toBe(false);
  });

  test('rejects a late catalog response after switching runtime targets', async () => {
    const firstRequest = deferred<PiResourceCatalogSnapshot>();
    let calls = 0;
    listImpl = async () => {
      calls += 1;
      if (calls === 1) return firstRequest.promise;
      return catalog(descriptor('remote'));
    };
    getImpl = async (_target, _kind, id) => document(id);
    const firstLoad = usePiResourcesStore.getState().loadCatalog('skill', target, targetKey);

    runtimeKey = 'runtime-b';
    await usePiResourcesStore.getState().loadCatalog('skill', target, 'runtime-b:project');
    firstRequest.resolve(catalog(descriptor('stale')));
    await firstLoad;

    const pane = usePiResourcesStore.getState().panes.skill;
    expect(pane.targetKey).toBe('runtime-b:project');
    expect(pane.selectedId).toBe('remote');
    expect(pane.catalog?.resources.map((resource) => resource.id)).toEqual(['remote']);
  });

  test('copies a read-only source into a writable managed scope and selects it', async () => {
    const external = document('external', '# external', 'external-revision', {
      sourceInfo: {
        origin: 'top-level',
        path: 'C:/external/prompt.md',
        scope: 'user',
        source: 'settings',
      },
      writable: false,
    });
    const copied = document('managed-copy');
    let currentCatalog = catalog(external.descriptor);
    listImpl = async () => currentCatalog;
    getImpl = async () => external;
    copyImpl = async () => {
      currentCatalog = catalog(external.descriptor, copied.descriptor);
      return copied;
    };
    await usePiResourcesStore.getState().loadCatalog('skill', target, targetKey);

    const success = await usePiResourcesStore.getState().copyResource(
      'skill',
      target,
      targetKey,
      'user',
      'managed-copy',
    );

    const pane = usePiResourcesStore.getState().panes.skill;
    expect(success).toBe(true);
    expect(pane.selectedId).toBe('managed-copy');
    expect(pane.document?.descriptor.writable).toBe(true);
    expect(pane.catalog?.resources).toHaveLength(2);
  });

  test('invalidates the runtime catalog only after a skill mutation succeeds', async () => {
    const reasons: string[] = [];
    const unsubscribe = subscribePiRuntimeCatalogChanged((reason) => reasons.push(reason));
    const created = document('workspace-check', '# skill', 'skill-revision', {
      filePath: 'C:/workspace/project/.pi/skills/workspace-check/SKILL.md',
      kind: 'skill',
      sourceInfo: {
        origin: 'top-level',
        path: 'C:/workspace/project/.pi/skills/workspace-check/SKILL.md',
        scope: 'project',
        source: 'project',
      },
    });
    createImpl = async () => created;
    listImpl = async () => catalog(created.descriptor);

    try {
      const success = await usePiResourcesStore.getState().createResource(
        'skill',
        target,
        targetKey,
        'project',
        'workspace-check',
        '# skill',
      );

      expect(success).toBe(true);
      expect(reasons).toEqual(['skill']);
    } finally {
      unsubscribe();
    }
  });
});
