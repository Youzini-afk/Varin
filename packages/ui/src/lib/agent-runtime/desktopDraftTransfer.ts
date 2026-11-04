import { getRuntimeEndpointGeneration, type ThreadIdentity } from '@varin/application-client';
import { DESKTOP_DRAFT_TRANSFER_MAX_BYTES, type DesktopDraftTransfer, type DesktopDraftTransferEvent } from '@varin/application-client/desktop';
import { invokeDesktop } from '@/lib/desktop';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT, hasUnsentDraftContent, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useThreadStore, selectedComposerKey, threadComposerKey } from '@/stores/useThreadStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useBotNavigation } from '@/lib/bots';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { isDesktopThreadNavigationTarget } from './desktopThreadNavigation';
import { currentWorkbenchProfileId, openThreadFromNavigation, startThreadFromNavigation } from './threadNavigation';

const snapshotIds = new WeakMap<ThreadDraft, string>();
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const transferLimit = () => new Error('This draft is too large for the native transfer buffer. It remains in Mini Chat.');

// Native JSON transport may reorder object properties. Scope equality is about
// the complete descriptor, not its property insertion order (or just its path).
function sameJSON(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJSON(item, right[index]));
  const a = object(left), b = object(right);
  return Boolean(a && b && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJSON(a[key], b[key])));
}
function hasPathReferences(draft: ThreadDraft): boolean {
  return Boolean(draft.selectedAttachments?.some(file => 'path' in file.selection)
    || draft.references?.some(reference => reference.target.kind === 'file' || reference.target.kind === 'directory'));
}
/** Read the same source descriptor as the receiving composer. A launch belongs
 * to the original Catalog snapshot, never to a claimed scope in the payload. */
async function referenceSource(draft: ThreadDraft, identity: ThreadIdentity | null): Promise<unknown> {
  if (!identity) return draft.sourceSelection ?? draft.workspacePath;
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!api) throw new Error('The conversation source is unavailable. Both drafts have been kept.');
  const snapshot = await api.snapshot(identity);
  if (snapshot.identity.threadId !== identity.threadId || snapshot.identity.branchId !== identity.branchId
    || snapshot.thread.thread_id !== identity.threadId) throw new Error('The conversation source does not match this draft');
  const branch = snapshot.thread.branches.find(value => value.branch_id === identity.branchId);
  if (!branch) throw new Error('The conversation branch is unavailable');
  const run = snapshot.activeRun ?? branch.latest_run;
  const launch = snapshot.launch?.run_id === run?.id ? snapshot.launch : null;
  const bot = Boolean(snapshot.thread.bot_id) && !snapshot.thread.parent_thread_id;
  return (bot ? undefined : draft.preparedSource?.source) ?? launch?.selection.source ?? (bot ? undefined : draft.workspacePath);
}
function rebasePathReferences(draft: ThreadDraft, source: Pick<DesktopDraftTransfer, 'sourceDraftKey' | 'sourceHostGeneration'>,
  generation: number, draftKey: string, descriptor: unknown): ThreadDraft {
  const targetScope = JSON.stringify([generation, draftKey, descriptor]);
  const targetDescriptor: unknown = JSON.parse(targetScope)[2];
  const rebase = (scope: string | undefined, host: number): string => {
    let parsed: unknown;
    try { parsed = scope === undefined ? undefined : JSON.parse(scope); } catch { /* Invalid scopes remain invalid. */ }
    if (host !== generation || !Array.isArray(parsed) || parsed.length !== 3
      || parsed[0] !== source.sourceHostGeneration || parsed[1] !== source.sourceDraftKey || !sameJSON(parsed[2], targetDescriptor)) {
      throw new Error('A referenced file belongs to an earlier source. Select it again. Both drafts have been kept.');
    }
    return targetScope;
  };
  return { ...draft,
    selectedAttachments: draft.selectedAttachments?.map(file => 'path' in file.selection ? { ...file, sourceKey: rebase(file.sourceKey, file.host) } : file),
    references: draft.references?.map(reference => reference.target.kind === 'file' || reference.target.kind === 'directory'
      ? { ...reference, target: { ...reference.target, sourceKey: rebase(reference.target.sourceKey, reference.host) } } : reference),
  };
}

function assertSettled(draft: ThreadDraft): void {
  if (draft.externalConversationId || draft.externalPreparationKey) {
    throw new Error('This external conversation belongs to its original execution owner. Its draft remains in Mini Chat.');
  }
  if (draft.pendingInput || draft.firstSend || draft.externalInput || draft.collaboration?.sending
    || draft.collaboration?.attempts?.length || draft.files?.some(file => file.status === 'preparing')
    || (draft.composerWorkflow?.assist?.pending && !draft.composerWorkflow.assist.receipt)
    || (draft.composerWorkflow?.handoff?.pending && !draft.composerWorkflow.handoff.receipt)
    || (draft.composerWorkflow?.remember?.pending && !draft.composerWorkflow.remember.receipt)) {
    throw new Error('This draft has a send or attachment operation awaiting confirmation. Keep Mini Chat open until it settles.');
  }
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  return btoa(chunks.join(''));
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) result[index] = decoded.charCodeAt(index);
  return result;
}

/** Copy bytes, never a source window's object URL. Unsupported values fail
 * before native admission and leave the original immutable draft untouched. */
export async function serializeDesktopDraft(draft: ThreadDraft): Promise<Record<string, unknown>> {
  assertSettled(draft);
  let budget = 0;
  const encode = async (value: unknown): Promise<unknown> => {
    if (value instanceof Blob) {
      budget += Math.ceil(value.size / 3) * 4;
      if (budget > DESKTOP_DRAFT_TRANSFER_MAX_BYTES) throw transferLimit();
      return { __varinDraftBlob: 1, mimeType: value.type, base64: base64(new Uint8Array(await value.arrayBuffer())) };
    }
    if (typeof value === 'string') {
      if (value.startsWith('blob:')) throw new Error('A renderer-local attachment could not be copied. The original draft remains in Mini Chat.');
      budget += new TextEncoder().encode(value).byteLength;
      if (budget > DESKTOP_DRAFT_TRANSFER_MAX_BYTES) throw transferLimit();
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(encode));
    if (value && typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('An attachment cannot be transferred safely. Keep the original draft open.');
      const entries = await Promise.all(Object.entries(value).filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await encode(item)] as const));
      return Object.fromEntries(entries);
    }
    if (value === undefined || value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new Error('The draft contains an unsupported transfer value.');
  };
  const images: ThreadDraft['images'] = [];
  let imageBytes = 0;
  for (const image of draft.images) {
    if (!image.data.startsWith('blob:')) {
      imageBytes += new TextEncoder().encode(image.data).byteLength;
      if (imageBytes > DESKTOP_DRAFT_TRANSFER_MAX_BYTES) throw transferLimit();
      images.push(image);
      continue;
    }
    const response = await fetch(image.data);
    if (!response.ok) throw new Error('The original image bytes are unavailable. Mini Chat remains open.');
    const blob = await response.blob();
    imageBytes += Math.ceil(blob.size / 3) * 4;
    if (imageBytes > DESKTOP_DRAFT_TRANSFER_MAX_BYTES) throw transferLimit();
    images.push({ ...image, data: base64(new Uint8Array(await blob.arrayBuffer())) });
  }
  return await encode({ ...draft, images }) as Record<string, unknown>;
}

export function deserializeDesktopDraft(transfer: DesktopDraftTransfer, targetGeneration: number): ThreadDraft {
  const decode = (value: unknown): unknown => {
    const record = object(value);
    if (record?.__varinDraftBlob === 1) {
      if (typeof record.mimeType !== 'string' || typeof record.base64 !== 'string') throw new Error('Invalid draft attachment bytes');
      return new Blob([bytes(record.base64)], { type: record.mimeType });
    }
    if (Array.isArray(value)) return value.map(decode);
    if (record) return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
    if (typeof value === 'string' && value.startsWith('blob:')) throw new Error('A source window Blob URL is not an attachment receipt');
    return value;
  };
  const value = object(decode(transfer.draft));
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.images) || !Array.isArray(value.materials)
    || value.images.some(image => typeof object(image)?.data !== 'string' || typeof object(image)?.mimeType !== 'string')
    || (value.files !== undefined && (!Array.isArray(value.files) || value.files.some(file => {
      const item = object(file);
      return !item || typeof item.id !== 'string' || typeof item.filename !== 'string' || typeof item.mimeType !== 'string' || !(item.data instanceof Blob);
    })))) throw new Error('The transferred composer data is invalid');
  const draft = value as unknown as ThreadDraft;
  assertSettled(draft);
  const generation = (original: number | undefined) => original === transfer.sourceHostGeneration ? targetGeneration : -1;
  return { ...draft,
    files: draft.files?.map(file => ({ ...file, preparationHost: generation(file.preparationHost) })),
    selectedAttachments: draft.selectedAttachments?.map(file => ({ ...file, host: generation(file.host) })),
    references: draft.references?.map(reference => ({ ...reference, host: generation(reference.host) })),
    ...(draft.externalConversationHost === undefined ? {} : { externalConversationHost: generation(draft.externalConversationHost) }),
    desktopHandoff: { sourceDraftKey: transfer.sourceDraftKey, snapshotId: transfer.snapshotId },
  };
}

/** A successful native result means the receiver committed its own copy. Later
 * source edits are not that copy and must remain in the original renderer. */
export async function transferSelectedDesktopDraft(context: { directory: string; projectId: string }): Promise<void> {
  const navigation = useThreadStore.getState();
  const sourceDraftKey = selectedComposerKey(navigation) ?? JSON.stringify([navigation.hostKey, 'draft', crypto.randomUUID()]);
  const snapshot = useThreadDraftStore.getState().drafts[sourceDraftKey];
  const draft = snapshot ?? EMPTY_THREAD_DRAFT;
  assertSettled(draft);
  const sourceHostGeneration = getRuntimeEndpointGeneration();
  const sourceIsCurrent = () => {
    const current = useThreadStore.getState();
    return getRuntimeEndpointGeneration() === sourceHostGeneration && current.hostKey === navigation.hostKey
      && selectedComposerKey(current) === selectedComposerKey(navigation)
      && current.selectedIdentity?.threadId === navigation.selectedIdentity?.threadId && current.selectedIdentity?.branchId === navigation.selectedIdentity?.branchId
      && useThreadDraftStore.getState().drafts[sourceDraftKey] === snapshot;
  };
  if (hasPathReferences(draft)) {
    const descriptor = await referenceSource(draft, navigation.selectedIdentity);
    if (!sourceIsCurrent()) throw new Error('The draft changed while preparing its copy. Please open it in main again.');
    rebasePathReferences(draft, { sourceDraftKey, sourceHostGeneration }, sourceHostGeneration, sourceDraftKey, descriptor);
  }
  let snapshotId = snapshotIds.get(draft);
  if (!snapshotId) { snapshotId = crypto.randomUUID(); snapshotIds.set(draft, snapshotId); }
  const transfer: DesktopDraftTransfer = {
    schemaVersion: 1, sourceDraftKey, snapshotId, sourceHostGeneration,
    ...context,
    ...(navigation.selectedIdentity ? { threadId: navigation.selectedIdentity.threadId, branchId: navigation.selectedIdentity.branchId } : {}),
    draft: await serializeDesktopDraft(draft),
  };
  if (new TextEncoder().encode(JSON.stringify(transfer)).byteLength > DESKTOP_DRAFT_TRANSFER_MAX_BYTES) throw transferLimit();
  if (!sourceIsCurrent()) throw new Error('The draft changed while preparing its copy. Please open it in main again.');
  const result = await invokeDesktop('desktop_transfer_draft', { transfer });
  if (!result?.accepted) throw new Error('The main window has not confirmed receiving this draft. Mini Chat remains open.');
  if (!sourceIsCurrent()) {
    throw new Error('The earlier copy reached the main window. Newer edits are still in Mini Chat, so this window remains open.');
  }
  if (snapshot) useThreadDraftStore.getState().remove(sourceDraftKey);
}

export async function acceptDesktopDraftTransfer(event: DesktopDraftTransferEvent): Promise<void> {
  const transfer = event?.transfer;
  if (!transfer || transfer.schemaVersion !== 1 || !transfer.sourceDraftKey || !transfer.snapshotId
    || !Number.isSafeInteger(transfer.sourceHostGeneration) || !isDesktopThreadNavigationTarget(event)) {
    throw new Error('The draft belongs to another Application Host or invalid transfer');
  }
  const host = useThreadStore.getState().hostKey, generation = getRuntimeEndpointGeneration();
  const assertCurrent = () => {
    if (host !== useThreadStore.getState().hostKey || generation !== getRuntimeEndpointGeneration() || !isDesktopThreadNavigationTarget(event)) throw new Error('Application Host changed during draft transfer');
  };
  if (Boolean(transfer.threadId) !== Boolean(transfer.branchId)) throw new Error('Both thread and branch identities are required');
  const identity = transfer.threadId && transfer.branchId ? { runtime: 'agent' as const, threadId: transfer.threadId, branchId: transfer.branchId } : null;
  const key = identity ? threadComposerKey(host, identity) : JSON.stringify([host, 'draft', 'handoff', transfer.sourceDraftKey]);
  let draft = deserializeDesktopDraft(transfer, generation);
  if (draft.identity && (!identity || draft.identity.threadId !== identity.threadId || draft.identity.branchId !== identity.branchId)) throw new Error('The draft conversation identity does not match its destination');
  const sameReceipt = (value: ThreadDraft | undefined) => value?.desktopHandoff?.sourceDraftKey === transfer.sourceDraftKey && value.desktopHandoff.snapshotId === transfer.snapshotId;
  const assertCanReceive = () => {
    assertCurrent();
    if (transfer.projectId && !useProjectsStore.getState().projects.some(project => project.id === transfer.projectId)) throw new Error('The draft project is unavailable on this Host');
    const existing = useThreadDraftStore.getState().drafts[key];
    if (existing && !sameReceipt(existing) && hasUnsentDraftContent(existing)) throw new Error('The main window already has a different unsent draft for this conversation. Both drafts have been kept.');
  };
  assertCanReceive();
  // Catalog-backed composers remain reachable after navigation. A local draft
  // has only one navigation entry: its receipt is usable only while selected,
  // or after we can safely restore that selection below without losing input.
  if (sameReceipt(useThreadDraftStore.getState().drafts[key])) {
    if (identity) {
      await useThreadStore.getState().resolveThread(identity);
      assertCanReceive();
      if (sameReceipt(useThreadDraftStore.getState().drafts[key])) return;
    } else if (useThreadStore.getState().selectedDraftKey === key) return;
  }
  const assertCanNavigate = () => {
    assertCanReceive();
    const selectedKey = useThreadStore.getState().selectedDraftKey;
    const selected = selectedKey && useThreadDraftStore.getState().drafts[selectedKey];
    if (selectedKey !== key && selected && !selected.identity && hasUnsentDraftContent(selected)) {
      throw new Error('The main window has another unsent local draft. Finish or clear it before opening Mini Chat here. Both drafts have been kept.');
    }
  };
  assertCanNavigate();
  if (hasPathReferences(draft)) {
    const descriptor = await referenceSource(draft, identity);
    assertCanNavigate();
    draft = rebasePathReferences(draft, transfer, generation, key, descriptor);
  }
  if (identity) {
    await openThreadFromNavigation({ ...identity, directory: transfer.directory || null, beforeCommit: assertCanNavigate });
    assertCanReceive();
    const selected = currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID
      ? useBotNavigation.getState().entry : useThreadStore.getState().selectedIdentity;
    if (selected?.threadId !== identity.threadId || selected?.branchId !== identity.branchId) throw new Error('Draft navigation was superseded');
    if (!sameReceipt(useThreadDraftStore.getState().drafts[key])) useThreadDraftStore.getState().replace(key, draft);
    useProjectsStore.getState().setActiveProjectIdOnly(transfer.projectId || null);
  } else {
    const target: NonNullable<Parameters<typeof startThreadFromNavigation>[0]> = {
      directory: transfer.directory || null, projectId: transfer.projectId || null, draftKey: key,
    };
    // Read the receipt at the actual commit boundary, after asynchronous shell
    // navigation. A duplicate that arrived meanwhile must not replace new edits.
    target.beforeCommit = () => {
      assertCanNavigate();
      target.draft = sameReceipt(useThreadDraftStore.getState().drafts[key]) ? undefined : draft;
    };
    await startThreadFromNavigation(target);
    assertCurrent();
    if (useThreadStore.getState().selectedDraftKey !== key) throw new Error('Draft navigation was superseded');
  }
  if (!sameReceipt(useThreadDraftStore.getState().drafts[key])) throw new Error('The receiving composer did not retain its draft copy');
}

export function listenDesktopDraftTransfers(target: EventTarget): () => void {
  let disposed = false;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<DesktopDraftTransferEvent>).detail;
    void acceptDesktopDraftTransfer(detail).then(() => {
      if (disposed) throw new Error('The receiving view closed before confirming the draft');
      return invokeDesktop('desktop_complete_draft_transfer', { transferId: detail.transferId, accepted: true });
    }, error => invokeDesktop('desktop_complete_draft_transfer', { transferId: detail?.transferId, accepted: false, reason: message(error) }))
      .catch(() => { /* A missing native receipt keeps the original source open. */ });
  };
  target.addEventListener('varin:transfer-draft', handler);
  return () => { disposed = true; target.removeEventListener('varin:transfer-draft', handler); };
}
