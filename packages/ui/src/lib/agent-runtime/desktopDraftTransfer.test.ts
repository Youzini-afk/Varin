import { beforeEach, expect, it, vi } from 'vitest';
import type { DesktopDraftTransfer, DesktopDraftTransferEvent } from '@varin/application-client/desktop';
import type { ThreadDraft } from '@/stores/useThreadDraftStore';
const state = vi.hoisted(() => ({ generation: 5, endpoint: 'https://source.example', projectId: '', directory: '', invoke: vi.fn(), projectAvailable: true, shell: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => state.generation, getRuntimeApiBaseUrl: () => state.endpoint, getRuntimeKey: () => 'source',
}));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: state.invoke }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ projects: state.projectAvailable ? [{ id: 'project-a' }] : [], setActiveProjectIdOnly: (id: string) => { state.projectId = id; } }) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: (value: string) => { state.directory = value; } }) } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setActiveMainTab: vi.fn(), closeMainSurfaces: vi.fn(), setSettingsDialogOpen: vi.fn() }) } }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: undefined }) }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: state.shell }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';
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
beforeEach(() => {
  state.generation = 5; state.endpoint = 'https://source.example'; state.projectId = ''; state.directory = ''; state.projectAvailable = true;
  state.invoke.mockReset(); state.shell.mockReset();
  useThreadDraftStore.setState({ drafts: {} });
  useThreadStore.setState({ hostKey, selectedIdentity: null, selectedDraftKey: null, threads: [] });
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
