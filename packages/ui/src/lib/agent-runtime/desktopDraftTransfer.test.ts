import { beforeEach, expect, it, vi } from 'vitest';
import type { DesktopDraftTransfer, DesktopDraftTransferEvent } from '@varin/application-client/desktop';
import type { DraftSourceSelection, ThreadDraft } from '@/stores/useThreadDraftStore';
import type { RuntimeAPIs, ThreadsAPI, ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { defaultVarinWorkbenchProfileDocument, type VarinWorkbenchProfileDocument } from '@varin/extension-contract';
const state = vi.hoisted(() => ({ generation: 5, endpoint: 'https://source.example', projectId: '', directory: '', invoke: vi.fn(), projectAvailable: true, shell: vi.fn(), document: undefined as VarinWorkbenchProfileDocument | undefined }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => state.generation, getRuntimeApiBaseUrl: () => state.endpoint, getRuntimeKey: () => 'source',
}));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: state.invoke }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ projects: state.projectAvailable ? [{ id: 'project-a' }] : [], setActiveProjectIdOnly: (id: string) => { state.projectId = id; } }) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: (value: string) => { state.directory = value; } }) } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setActiveMainTab: vi.fn(), closeMainSurfaces: vi.fn(), setSettingsDialogOpen: vi.fn() }) } }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: state.document ? { workbench: { authoritative: true, document: state.document } } : undefined }) }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: state.shell }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { bindThreadStore, threadComposerKey, useThreadStore } from '@/stores/useThreadStore';
import { useBotNavigation } from '@/lib/bots';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { composerFileSelections } from '@/components/chat/composer/submit/fileSelections';
import { composerInputReferences } from '@/components/chat/composer/submit/references';
import { acceptDesktopDraftTransfer, serializeDesktopDraft, deserializeDesktopDraft, transferSelectedDesktopDraft, listenDesktopDraftTransfers } from './desktopDraftTransfer';
const hostKey = 'same-native-host';
const context = { directory: '/projects/a', projectId: 'project-a' };
const completeDraft = (): ThreadDraft => ({
  text: 'Review @notes and image 3', images: [{ mimeType: 'image/png', data: 'AQID', reference: 3 }], imageReferenceSequence: 7,
  materials: [{ snapshotId: 'material-1', filename: 'paper.pdf' }], preparedSource: null, workspacePath: '/projects/a',
  files: [{ id: 'original-upload-key', filename: 'notes.txt', mimeType: 'text/plain', status: 'ready', data: new Blob(['original binary\0bytes'], { type: 'text/plain' }),
    attachment: { ref: 'attachment:original', filename: 'notes.txt', mimeType: 'text/plain', byteLength: 21 }, preparedScope: 'source-scope', preparationHost: 5 }],
  selectedAttachments: [{ id: 'selected', filename: 'existing.txt', host: 5, selection: { ref: 'attachment:retained' } }],
  references: [{ id: 'reference', from: 7, to: 13, text: '@notes', host: 5, target: { kind: 'draft-file', fileId: 'original-upload-key' } }],
});
const transfer = async (draft = completeDraft()): Promise<DesktopDraftTransfer> => ({ schemaVersion: 1, sourceDraftKey: 'source-key', snapshotId: 'snapshot-1', sourceHostGeneration: 5, ...context, draft: await serializeDesktopDraft(draft) });
const event = (payload: DesktopDraftTransfer): DesktopDraftTransferEvent => ({ transferId: 'native-transfer', apiBaseUrl: state.endpoint, relayHostId: '', transfer: payload });
const selection: DraftSourceSelection = { path: '/projects/a', resourceOwner: { kind: 'managed_host', hostId: 'remote', connectionId: 'connection', endpointIdentity: 'endpoint' }, mode: 'fixed_branch', contentMode: 'saved-files', captureScopes: ['src', 'docs'] };
const pathDraft = (sourceKey = 'source-key', source: unknown = '/projects/a'): ThreadDraft => {
  const scope = JSON.stringify([5, sourceKey, source]);
  return { text: '@notes @docs', images: [], materials: [], preparedSource: null, workspacePath: '/projects/a',
    selectedAttachments: [{ id: 'notes', host: 5, filename: 'notes.txt', sourceKey: scope, selection: { path: '/projects/a/notes.txt' } }],
    references: [
      { id: 'notes', host: 5, from: 0, to: 6, text: '@notes', target: { kind: 'file', path: '/projects/a/notes.txt', workspacePath: '/projects/a', sourceKey: scope } },
      { id: 'docs', host: 5, from: 7, to: 12, text: '@docs', target: { kind: 'directory', path: '/projects/a/docs', workspacePath: '/projects/a', sourceKey: scope } },
    ],
  };
};
// serde_json changes object insertion order but does not rewrite scope strings.
const nativeJSON = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
function expectSendablePaths(draft: ThreadDraft, scope: string): void {
  expect(composerFileSelections(draft.selectedAttachments, scope)).toEqual([{ path: '/projects/a/notes.txt' }]);
  expect(composerInputReferences(draft.text, draft.references, scope)).toEqual({ references: [{ kind: 'directory', path: '/projects/a/docs', start: 7, end: 12 }] });
}
beforeEach(() => {
  state.generation = 5; state.endpoint = 'https://source.example'; state.projectId = ''; state.directory = ''; state.projectAvailable = true;
  state.invoke.mockReset(); state.document = undefined;
  state.shell.mockReset().mockImplementation(async (profile: string) => { if (state.document) state.document.activeProfileId = profile; });
  useBotNavigation.setState({ botId: null, entry: null, model: null });
  useThreadDraftStore.setState({ drafts: {} });
  useThreadStore.setState({ hostKey, selectedIdentity: null, selectedDraftKey: null, threads: [] });
  registerRuntimeAPIs(null);
});

it.each([false, true])('keeps path selections sendable after the actual handoff key, generation and native JSON order change (explicit source: %s)', async explicit => {
  const source = pathDraft('source-key', explicit ? selection : '/projects/a');
  if (explicit) source.sourceSelection = selection;
  const payload = nativeJSON(await transfer(source));
  state.generation = 12;
  const target = new EventTarget(), dispose = listenDesktopDraftTransfers(target);
  state.invoke.mockResolvedValue(null);
  target.dispatchEvent(new CustomEvent('varin:transfer-draft', { detail: event(payload) }));
  await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledExactlyOnceWith('desktop_complete_draft_transfer', { transferId: 'native-transfer', accepted: true }));
  const key = useThreadStore.getState().selectedDraftKey!;
  expect(key).not.toBe(payload.sourceDraftKey);
  const received = useThreadDraftStore.getState().drafts[key];
  expectSendablePaths(received, JSON.stringify([state.generation, key, received.sourceSelection ?? received.workspacePath]));
  expect(source.selectedAttachments![0].sourceKey).toBe(JSON.stringify([5, 'source-key', explicit ? selection : '/projects/a']));
  dispose();
});

it.each([
  ['older generation', JSON.stringify([4, 'source-key', selection])],
  ['another draft', JSON.stringify([5, 'other-draft', selection])],
  ['another resource owner', JSON.stringify([5, 'source-key', { ...selection, resourceOwner: { ...selection.resourceOwner, hostId: 'foreign' } }])],
  ['different capture scopes', JSON.stringify([5, 'source-key', { ...selection, captureScopes: ['src'] }])],
  ['malformed scope', 'not-json'],
  ['extended scope', JSON.stringify([5, 'source-key', selection, 'extra'])],
])('never revives a path binding with %s', async (_label, scope) => {
  const source = pathDraft('source-key', selection); source.sourceSelection = selection;
  source.selectedAttachments![0].sourceKey = scope;
  state.generation = 12;
  await expect(acceptDesktopDraftTransfer(event(nativeJSON(await transfer(source))))).rejects.toThrow('earlier source');
  expect(useThreadStore.getState().selectedDraftKey).toBeNull();
  expect(useThreadDraftStore.getState().drafts).toEqual({});
});

it('checks inline directory scopes and stale Host generations independently from selected files', async () => {
  const source = pathDraft();
  const directory = source.references![1].target;
  if (directory.kind !== 'directory') throw new Error('Directory fixture required');
  directory.sourceKey = JSON.stringify([5, 'source-key', '/old-project']);
  await expect(acceptDesktopDraftTransfer(event(await transfer(source)))).rejects.toThrow('earlier source');
  directory.sourceKey = JSON.stringify([5, 'source-key', '/projects/a']);
  source.references![1].host = 4;
  await expect(acceptDesktopDraftTransfer(event(await transfer(source)))).rejects.toThrow('earlier source');
  expect(useThreadStore.getState().selectedDraftKey).toBeNull();
});

it('copies actual text, image bytes, Blob metadata, retained file references, and project into the receiving store', async () => {
  const source = completeDraft(), payload = await transfer(source);
  state.generation = 12;
  await acceptDesktopDraftTransfer(event(payload));
  const key = useThreadStore.getState().selectedDraftKey!;
  const received = useThreadDraftStore.getState().drafts[key];
  expect(received.text).toBe(source.text); expect(received.images).toEqual(source.images);
  expect(received.imageReferenceSequence).toBe(7); expect(received.materials).toEqual(source.materials);
  expect(received.files![0]).toMatchObject({ id: 'original-upload-key', filename: 'notes.txt', mimeType: 'text/plain', attachment: source.files![0]!.attachment, preparedScope: 'source-scope', preparationHost: 12 });
  expect(received.files![0]!.data).not.toBe(source.files![0]!.data);
  expect(await received.files![0]!.data.text()).toBe('original binary\0bytes');
  expect(received.selectedAttachments![0]!.host).toBe(12); expect(received.references![0]!.host).toBe(12);
  expect(state.projectId).toBe('project-a'); expect(state.directory).toBe('/projects/a'); expect(received.workspacePath).toBe('/projects/a');
  expect(source.files![0]!.preparationHost).toBe(5);
});

it('does not forward Blob URLs as images and does not revive stale Host references', async () => {
  const original = completeDraft(); original.images = [{ mimeType: 'image/png', data: URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])])) }];
  original.references![0]!.host = 4;
  const fetchBlob = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => { expect(input).toBe(original.images[0]!.data); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }); });
  try {
    const payload = await transfer(original);
    expect(JSON.stringify(payload)).not.toContain('blob:');
    const received = deserializeDesktopDraft(payload, 12);
    expect(received.images[0]!.data).toBe('AQID'); expect(received.references![0]!.host).toBe(-1);
  } finally { fetchBlob.mockRestore(); URL.revokeObjectURL(original.images[0]!.data); }
});

it('acknowledges only after real receiving-store installation and survives removal of the original source', async () => {
  const payload = await transfer(); const target = new EventTarget();
  const dispose = listenDesktopDraftTransfers(target);
  state.invoke.mockImplementation(async (command: string, args: { accepted: boolean }) => {
    expect(command).toBe('desktop_complete_draft_transfer'); expect(args.accepted).toBe(true);
    const received = useThreadDraftStore.getState().drafts[useThreadStore.getState().selectedDraftKey!];
    expect(received.text).toBe('Review @notes and image 3');
    expect(await received.files![0]!.data.text()).toBe('original binary\0bytes');
  });
  target.dispatchEvent(new CustomEvent('varin:transfer-draft', { detail: event(payload) }));
  await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledOnce());
  useThreadDraftStore.getState().remove('source-key');
  expect(useThreadDraftStore.getState().drafts[useThreadStore.getState().selectedDraftKey!].text).toBe('Review @notes and image 3');
  dispose();
});

it('rejects another Host or missing project without losing either renderer draft', async () => {
  const key = useThreadStore.getState().openDraft(); useThreadDraftStore.getState().patch(key, { text: 'Existing target draft' });
  const payload = await transfer();
  await expect(acceptDesktopDraftTransfer({ ...event(payload), apiBaseUrl: 'https://foreign.example' })).rejects.toThrow('another Application Host');
  state.projectAvailable = false;
  await expect(acceptDesktopDraftTransfer(event(payload))).rejects.toThrow('project is unavailable');
  expect(useThreadStore.getState().selectedDraftKey).toBe(key); expect(useThreadDraftStore.getState().drafts[key].text).toBe('Existing target draft');
});

it('repeated delivery acknowledges the same snapshot without overwriting later target edits', async () => {
  const payload = await transfer(); await acceptDesktopDraftTransfer(event(payload));
  const key = useThreadStore.getState().selectedDraftKey!;
  useThreadDraftStore.getState().patch(key, { text: 'Edited after receipt' });
  await acceptDesktopDraftTransfer(event(payload));
  expect(useThreadStore.getState().selectedDraftKey).toBe(key); expect(useThreadDraftStore.getState().drafts[key].text).toBe('Edited after receipt');
  await expect(acceptDesktopDraftTransfer(event({ ...payload, snapshotId: 'new-snapshot' }))).rejects.toThrow('different unsent draft');
  expect(useThreadDraftStore.getState().drafts[key].text).toBe('Edited after receipt');
});

it.each([
  { text: 'An unfinished local draft' },
  { text: '', pendingInput: { status: 'unknown' } as ThreadDraft['pendingInput'] },
  { text: '', externalPreparationKey: 'unconfirmed-creation' },
])('keeps another unsent local draft reachable instead of replacing its only navigation entry', async change => {
  const key = useThreadStore.getState().openDraft();
  useThreadDraftStore.getState().patch(key, change);
  const original = useThreadDraftStore.getState().drafts[key];
  await expect(acceptDesktopDraftTransfer(event(await transfer()))).rejects.toThrow('another unsent local draft');
  expect(useThreadStore.getState().selectedDraftKey).toBe(key);
  expect(useThreadDraftStore.getState().drafts).toEqual({ [key]: original });
  expect(state.projectId).toBe(''); expect(state.directory).toBe('');
});

it('rechecks the currently selected local draft after async navigation, including input typed during preparation', async () => {
  const key = useThreadStore.getState().openDraft();
  const payload = await transfer();
  const pending = acceptDesktopDraftTransfer(event(payload));
  useThreadDraftStore.getState().patch(key, { text: 'Typed while the incoming draft was preparing' });
  await expect(pending).rejects.toThrow('another unsent local draft');
  expect(useThreadStore.getState().selectedDraftKey).toBe(key);
  expect(Object.keys(useThreadDraftStore.getState().drafts)).toEqual([key]);
});

it('acknowledges a repeated receipt without switching away from a newer local draft', async () => {
  const payload = await transfer(); await acceptDesktopDraftTransfer(event(payload));
  const receivedKey = useThreadStore.getState().selectedDraftKey!;
  const newerKey = useThreadStore.getState().openDraft();
  useThreadDraftStore.getState().patch(newerKey, { text: 'New local work' });
  const received = useThreadDraftStore.getState().drafts[receivedKey];
  await acceptDesktopDraftTransfer(event(payload));
  expect(useThreadStore.getState().selectedDraftKey).toBe(newerKey);
  expect(useThreadDraftStore.getState().drafts[receivedKey]).toBe(received);
  expect(useThreadDraftStore.getState().drafts[newerKey].text).toBe('New local work');
});

it('checks receiving-store conflicts and repeated receipts again after asynchronous navigation', async () => {
  const payload = await transfer();
  const key = JSON.stringify([hostKey, 'draft', 'handoff', payload.sourceDraftKey]);
  const conflicting = acceptDesktopDraftTransfer(event(payload));
  useThreadDraftStore.getState().patch(key, { text: 'Target typed while navigating' });
  await expect(conflicting).rejects.toThrow('different unsent draft');
  expect(useThreadDraftStore.getState().drafts[key].text).toBe('Target typed while navigating');

  useThreadDraftStore.getState().remove(key);
  const repeated = acceptDesktopDraftTransfer(event(payload));
  useThreadDraftStore.getState().replace(key, {
    ...completeDraft(), text: 'Edits after a concurrent receipt',
    desktopHandoff: { sourceDraftKey: payload.sourceDraftKey, snapshotId: payload.snapshotId },
  });
  await repeated;
  expect(useThreadDraftStore.getState().drafts[key].text).toBe('Edits after a concurrent receipt');
});

it('source retains actual data on receiver rejection or native timeout, and never invokes close', async () => {
  const key = useThreadStore.getState().openDraft(); useThreadDraftStore.getState().replace(key, completeDraft());
  const original = useThreadDraftStore.getState().drafts[key];
  for (const error of ['Target rejected the draft', 'Draft transfer timed out; outcome is unknown']) {
    state.invoke.mockRejectedValueOnce(new Error(error));
    await expect(transferSelectedDesktopDraft(context)).rejects.toThrow(error);
    expect(useThreadDraftStore.getState().drafts[key]).toBe(original);
  }
  expect(state.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  const payloads = state.invoke.mock.calls.map(call => call[1].transfer);
  expect(payloads[0].snapshotId).toBe(payloads[1].snapshotId);
});

it('source releases only its acknowledged immutable snapshot, retaining newly typed text', async () => {
  const key = useThreadStore.getState().openDraft(); useThreadDraftStore.getState().replace(key, completeDraft());
  let accept!: (result: { accepted: true }) => void;
  state.invoke.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  const handoff = transferSelectedDesktopDraft(context);
  await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledOnce());
  useThreadDraftStore.getState().patch(key, { text: 'Newer input' });
  accept({ accepted: true });
  await expect(handoff).rejects.toThrow('Newer edits');
  expect(useThreadDraftStore.getState().drafts[key].text).toBe('Newer input');
  state.invoke.mockResolvedValue({ accepted: true });
  await transferSelectedDesktopDraft(context);
  expect(useThreadDraftStore.getState().drafts[key]).toBeUndefined();
});

it('keeps Mini Chat open when its user switches to a newer draft while native receipt is pending', async () => {
  const originalKey = useThreadStore.getState().openDraft(); useThreadDraftStore.getState().replace(originalKey, completeDraft());
  let accept!: (result: { accepted: true }) => void;
  state.invoke.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  const pending = transferSelectedDesktopDraft(context);
  await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledOnce());
  const newerKey = useThreadStore.getState().openDraft(); useThreadDraftStore.getState().patch(newerKey, { text: 'A different unsent draft' });
  accept({ accepted: true });
  await expect(pending).rejects.toThrow('window remains open');
  expect(useThreadStore.getState().selectedDraftKey).toBe(newerKey);
  expect(useThreadDraftStore.getState().drafts[newerKey].text).toBe('A different unsent draft');
  expect(useThreadDraftStore.getState().drafts[originalKey]).toBeDefined();
});

it('does not transfer an upload in progress or an uncertain send', async () => {
  const draft = completeDraft(); draft.files![0]!.status = 'preparing';
  await expect(serializeDesktopDraft(draft)).rejects.toThrow('awaiting confirmation');
  draft.files![0]!.status = 'ready';
  draft.pendingInput = { status: 'unknown' } as ThreadDraft['pendingInput'];
  await expect(serializeDesktopDraft(draft)).rejects.toThrow('awaiting confirmation');
  expect(state.invoke).not.toHaveBeenCalled();
});

it('keeps an external conversation with its original owner and refuses oversized bytes before native admission', async () => {
  const external = completeDraft(); external.externalConversationId = 'external-session'; external.externalConversationHost = 5;
  await expect(serializeDesktopDraft(external)).rejects.toThrow('original execution owner');
  const draft = completeDraft();
  Object.defineProperty(draft.files![0]!.data, 'size', { value: 64 * 1024 * 1024 });
  const read = vi.spyOn(draft.files![0]!.data, 'arrayBuffer');
  await expect(serializeDesktopDraft(draft)).rejects.toThrow('native transfer buffer');
  expect(read).not.toHaveBeenCalled(); expect(state.invoke).not.toHaveBeenCalled();
});

it('the receiver sends a negative receipt when its project context is unavailable', async () => {
  const payload = await transfer(); state.projectAvailable = false;
  state.invoke.mockResolvedValue(null);
  const target = new EventTarget(), dispose = listenDesktopDraftTransfers(target);
  target.dispatchEvent(new CustomEvent('varin:transfer-draft', { detail: event(payload) }));
  await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledWith('desktop_complete_draft_transfer', {
    transferId: 'native-transfer', accepted: false, reason: 'The draft project is unavailable on this Host',
  }));
  expect(useThreadStore.getState().selectedDraftKey).toBeNull();
  expect(useThreadDraftStore.getState().drafts).toEqual({});
  dispose();
});

it.each([{ bot: false, owner: 'ordinary Thread' }, { bot: true, owner: 'Bot' }])('installs a bound draft through its actual $owner navigation without submitting', async ({ bot }) => {
  state.document = defaultVarinWorkbenchProfileDocument();
  const identity: ThreadIdentity = { runtime: 'agent', threadId: 'bound-thread', branchId: 'review-branch' };
  const summary: ThreadSummary = {
    thread_id: identity.threadId, main_branch_id: 'main-branch', title: 'Bound conversation', revision: 1, created_at_ms: 0, updated_at_ms: 0,
    pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
    bot_id: bot ? 'bot-owner' : null, parent_thread_id: null, observer_project_ids: [],
    branches: ['main-branch', identity.branchId].map(branch_id => ({ branch_id, head: null, active_run_id: null, latest_run: null })),
  };
  const create = vi.fn(), submit = vi.fn();
  const api = { list: async () => [summary], create, submit,
    observe: async (_cursor: number, _listener: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
  } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ bots: { get: async () => ({ id: 'bot-owner', archived: false }) } } as unknown as RuntimeAPIs);
  const unbind = bindThreadStore(api);
  try {
    await useThreadStore.getState().loadCatalog();
    await useThreadStore.getState().selectThread({ threadId: identity.threadId, branchId: 'main-branch' });
    const payload = { ...await transfer({ ...completeDraft(), identity }), threadId: identity.threadId, branchId: identity.branchId };
    await acceptDesktopDraftTransfer(event(payload));
    const received = useThreadDraftStore.getState().drafts[threadComposerKey(useThreadStore.getState().hostKey, identity)];
    expect(received.identity).toEqual(identity);
    expect(received.text).toBe('Review @notes and image 3');
    expect(await received.files![0]!.data.text()).toBe('original binary\0bytes');
    if (bot) {
      expect(useBotNavigation.getState().entry).toEqual(identity);
      expect(useThreadStore.getState().selectedIdentity?.branchId).toBe('main-branch');
    } else {
      expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
      expect(state.directory).toBe('/projects/a');
    }
    expect(state.projectId).toBe('project-a');
    expect(create).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  } finally { unbind(); registerRuntimeAPIs(null); }
});

async function boundFixture(bot = false) {
  const identity: ThreadIdentity = { runtime: 'agent', threadId: 'source-thread', branchId: 'source-branch' };
  const run: NonNullable<ThreadSnapshot['activeRun']> = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating', revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
  const summary: ThreadSummary = {
    thread_id: identity.threadId, main_branch_id: identity.branchId, title: 'Existing conversation', revision: 1, created_at_ms: 0, updated_at_ms: 0,
    pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
    bot_id: bot ? 'bot-owner' : null, parent_thread_id: null, observer_project_ids: [],
    branches: [{ branch_id: identity.branchId, head: null, active_run_id: run.id, latest_run: run }],
  };
  const view: ThreadSnapshot = { identity, eventCursor: 0, thread: summary, activeRun: run,
    history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [], modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] },
    launch: { run_id: run.id, revision: 1, policy_generation: 0, policy_preparable: false, driver_preparable: false, policy_target: { kind: 'default' }, startable: false, requires_rebind: false, bound_epoch: null, preparation_failure: null, pause: null,
      selection: { extension_bindings: [], child_dispatch: null, driver: { kind: 'builtin', name: 'varin.default', version: '1' }, driver_models: [], policy_models: [], mcp_binding: null, credential_scope: null, connection_identity: 'fixture', provider_family: 'fixture', model: 'fixture',
        configuration_generation: 1, tool_schema_generation: 1, tools: [], policy: { name: 'fixture', version: '1' },
        source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'workspace', execution_workspace_id: 'execution', branch_id: null, revision: null, live_root: { hostId: 'native-host', canonicalRoot: '/projects/a', rootId: 'root' } } } },
  };
  const snapshot = vi.fn(async () => view);
  const api = { list: async () => [summary], snapshot,
    observe: async (_cursor: number, _listener: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
  } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ threads: api, bots: { get: async () => ({ id: 'bot-owner', archived: false }) } } as unknown as RuntimeAPIs);
  const unbind = bindThreadStore(api);
  await useThreadStore.getState().loadCatalog();
  await useThreadStore.getState().selectThread(identity);
  return { identity, view, snapshot, unbind };
}

it.each(['prepared', 'launch', 'workspace', 'bot'] as const)('uses the actual %s source of an established conversation and keeps its paths sendable', async mode => {
  const f = await boundFixture(mode === 'bot');
  try {
    const prepared: NonNullable<ThreadDraft['preparedSource']> = { path: '/prepared', source: { resourceOwner: { kind: 'local' }, workspaceId: 'prepared', executionWorkspaceId: 'prepared-execution', tools: ['file_read'], mode: 'fixed_branch', branchId: 'prepared-branch', revision: 7 } };
    if (mode === 'workspace') f.view.launch = null;
    const descriptor = mode === 'prepared' ? prepared.source : f.view.launch?.selection.source ?? '/projects/a';
    const source = { ...pathDraft('source-key', descriptor), identity: f.identity, sourceSelection: selection,
      ...(mode === 'prepared' || mode === 'bot' ? { preparedSource: prepared } : {}) };
    const payload = nativeJSON({ ...await transfer(source), threadId: f.identity.threadId, branchId: f.identity.branchId });
    state.generation = 12;
    await acceptDesktopDraftTransfer(event(payload));
    const key = threadComposerKey(useThreadStore.getState().hostKey, f.identity), received = useThreadDraftStore.getState().drafts[key];
    const targetDescriptor = mode === 'prepared' ? received.preparedSource!.source : f.view.launch?.selection.source ?? received.workspacePath;
    expectSendablePaths(received, JSON.stringify([state.generation, key, targetDescriptor]));
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(f.identity);
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it('validates a source conversation against its current snapshot before native admission', async () => {
  const f = await boundFixture();
  try {
    const key = threadComposerKey(useThreadStore.getState().hostKey, f.identity);
    useThreadDraftStore.getState().replace(key, { ...pathDraft(key, '/old-project'), identity: f.identity });
    await expect(transferSelectedDesktopDraft(context)).rejects.toThrow('earlier source');
    expect(state.invoke).not.toHaveBeenCalled();
    const current = { ...pathDraft(key, f.view.launch!.selection.source), identity: f.identity };
    useThreadDraftStore.getState().replace(key, current);
    state.invoke.mockResolvedValue({ accepted: true });
    await transferSelectedDesktopDraft(context);
    expect(state.invoke).toHaveBeenCalledExactlyOnceWith('desktop_transfer_draft', { transfer: expect.objectContaining({ sourceDraftKey: key, sourceHostGeneration: 5, threadId: f.identity.threadId, branchId: f.identity.branchId }) });
    expect(useThreadDraftStore.getState().drafts[key]).toBeUndefined();
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it.each(['source edit', 'source navigation', 'Host switch'] as const)('fences a delayed source snapshot after a %s', async change => {
  const f = await boundFixture();
  try {
    const key = threadComposerKey(useThreadStore.getState().hostKey, f.identity);
    useThreadDraftStore.getState().replace(key, { ...pathDraft(key, f.view.launch!.selection.source), identity: f.identity });
    let finish!: (value: ThreadSnapshot) => void;
    f.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = transferSelectedDesktopDraft(context);
    if (change === 'source edit') useThreadDraftStore.getState().patch(key, { text: 'New input' });
    if (change === 'source navigation') useThreadStore.getState().openDraft();
    if (change === 'Host switch') state.generation++;
    finish(f.view);
    await expect(pending).rejects.toThrow('draft changed');
    expect(state.invoke).not.toHaveBeenCalled();
    expect(useThreadDraftStore.getState().drafts[key]).toBeDefined();
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it('retains source paths when the original snapshot owner is unavailable', async () => {
  const f = await boundFixture();
  try {
    const key = threadComposerKey(useThreadStore.getState().hostKey, f.identity);
    const draft = { ...pathDraft(key, f.view.launch!.selection.source), identity: f.identity };
    useThreadDraftStore.getState().replace(key, draft);
    f.snapshot.mockRejectedValueOnce(new Error('Snapshot unavailable'));
    await expect(transferSelectedDesktopDraft(context)).rejects.toThrow('Snapshot unavailable');
    expect(state.invoke).not.toHaveBeenCalled();
    expect(useThreadDraftStore.getState().drafts[key]).toBe(draft);
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it('allows returning to ordinary Catalog-backed unsent input after receiving a new local draft', async () => {
  const f = await boundFixture();
  try {
    const key = threadComposerKey(useThreadStore.getState().hostKey, f.identity);
    useThreadDraftStore.getState().patch(key, { text: 'Unsent input on an existing Thread' });
    await acceptDesktopDraftTransfer(event(await transfer()));
    expect(useThreadStore.getState().selectedDraftKey).not.toBeNull();
    await useThreadStore.getState().selectThread(f.identity);
    expect(useThreadStore.getState().selectedIdentity).toEqual(f.identity);
    expect(useThreadDraftStore.getState().drafts[key].text).toBe('Unsent input on an existing Thread');
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it('protects input typed while an incoming established Thread resolves its Catalog identity', async () => {
  const f = await boundFixture();
  try {
    const local = useThreadStore.getState().openDraft();
    const payload = { ...await transfer(), threadId: f.identity.threadId, branchId: f.identity.branchId };
    const pending = acceptDesktopDraftTransfer(event(payload));
    useThreadDraftStore.getState().patch(local, { text: 'Typed during Thread navigation' });
    await expect(pending).rejects.toThrow('another unsent local draft');
    expect(useThreadStore.getState().selectedDraftKey).toBe(local);
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
    expect(useThreadDraftStore.getState().drafts[local].text).toBe('Typed during Thread navigation');
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it.each([false, true])('guards a late local edit at the actual leaving-Bot selection boundary (bound target: %s)', async bound => {
  const f = await boundFixture();
  try {
    state.document = defaultVarinWorkbenchProfileDocument(); state.document.activeProfileId = 'varin.bot';
    const local = useThreadStore.getState().openDraft();
    state.shell.mockImplementationOnce(async (profile: string, _workspace: string | undefined, options: { beforeCommit(): Promise<void>; selectOnLeavingBot?: () => void }) => {
      await options.beforeCommit();
      // Shell preparation is complete, but a late edit can still arrive before
      // the reveal restores or replaces the ordinary conversation selection.
      useThreadDraftStore.getState().patch(local, { text: 'Typed before the Bot reveal' });
      if (options.selectOnLeavingBot) options.selectOnLeavingBot();
      else await useThreadStore.getState().selectThread(f.identity);
      state.document!.activeProfileId = profile;
    });
    const payload = { ...await transfer(), ...(bound ? { threadId: f.identity.threadId, branchId: f.identity.branchId } : {}) };
    await expect(acceptDesktopDraftTransfer(event(payload))).rejects.toThrow('another unsent local draft');
    expect(useThreadStore.getState().selectedDraftKey).toBe(local);
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
    expect(useThreadDraftStore.getState().drafts[local].text).toBe('Typed before the Bot reveal');
    expect(useThreadDraftStore.getState().drafts[threadComposerKey(useThreadStore.getState().hostKey, f.identity)]).toBeUndefined();
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});

it.each(['Host switch', 'wrong snapshot identity', 'new local input'] as const)('fences a delayed receiving snapshot after %s', async change => {
  const f = await boundFixture();
  try {
    const payload = { ...await transfer({ ...pathDraft('source-key', f.view.launch!.selection.source), identity: f.identity }), threadId: f.identity.threadId, branchId: f.identity.branchId };
    let finish!: (value: ThreadSnapshot) => void;
    f.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = acceptDesktopDraftTransfer(event(payload));
    if (change === 'Host switch') state.generation++;
    if (change === 'new local input') {
      const local = useThreadStore.getState().openDraft();
      useThreadDraftStore.getState().patch(local, { text: 'New receiving input' });
    }
    finish(change === 'wrong snapshot identity' ? { ...f.view, identity: { ...f.identity, branchId: 'foreign' } } : f.view);
    await expect(pending).rejects.toThrow(change === 'Host switch' ? 'Host changed' : change === 'new local input' ? 'another unsent local draft' : 'does not match');
    expect(useThreadDraftStore.getState().drafts[threadComposerKey(useThreadStore.getState().hostKey, f.identity)]).toBeUndefined();
  } finally { f.unbind(); registerRuntimeAPIs(null); }
});
