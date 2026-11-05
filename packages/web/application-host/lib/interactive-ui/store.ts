import { normalizeConversationUi, migrateConversationUiState } from '@varin/application-client';
import { createHash, randomUUID } from 'node:crypto';
import type { RenderUiInput, UiReceipt, UiSource, UiObservation, UiSelection, UiViewState, UiSourceIdentity, UiMessageFragment, UiBranchScope, ConversationUiNode } from '@varin/application-client';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult, MaterialRetention } from '../kernel/protocol.generated.js';
import { createUiActivity, releaseUiRecords } from './lifecycle.js';

/** code names a public, stable reason that survives the generic resource wrapper. */
export class UiContentError extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); } }
export class UiMutationUnknownError extends UiContentError { constructor() { super('Save outcome is not confirmed; the original call was not repeated', 503); } }
type FileObject = { hash: string; slot: string; mediaRefs?: string[] };
type Revision = Omit<UiReceipt, 'kind' | 'files'> & { branchScope?: UiBranchScope; forkedFrom?: string; content?: ConversationUiNode; definition?: unknown; messageFragment?: UiMessageFragment; files: Record<string, FileObject>; assets: Record<string, FileObject & { mimeType: string }> };
export interface Work { versions: Revision[]; mutation: { intent: string; receipt: UiReceipt } }
export interface ViewRecord { clientId?: string; branchScope?: UiBranchScope; source: UiSourceIdentity; state: UiViewState | null; lease?: { token: string; clientId: string } | null }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function uiPath(value: string) {
  if (typeof value !== 'string' || !value || /^(?:[a-z]+:|[\\/])/i.test(value) || value.includes('\0')) throw new UiContentError('Use a relative work file path');
  const parts = value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new UiContentError('File path leaves this work');
  return parts.join('/');
}
export function applyUiEdits(text: string, edits: { oldText: string; newText: string }[]) {
  const matches = edits.map(edit => {
    if (!edit.oldText) throw new UiContentError('oldText must not be empty');
    const start = text.indexOf(edit.oldText);
    if (start < 0 || text.indexOf(edit.oldText, start + 1) >= 0) throw new UiContentError('oldText must match exactly once');
    return { start, end: start + edit.oldText.length, text: edit.newText };
  }).sort((a, b) => a.start - b.start);
  if (matches.some((match, index) => index > 0 && match.start < matches[index - 1]!.end)) throw new UiContentError('Edits overlap');
  let result = '', offset = 0;
  for (const match of matches) { result += text.slice(offset, match.start) + match.text; offset = match.end; }
  return result + text.slice(offset);
}
const receipt = (version: Revision): UiReceipt => ({ kind: 'ui', ref: version.ref, workRef: version.workRef, title: version.title,
  revision: version.revision, entry: version.entry, files: Object.keys(version.files) });
export function createUiContentStore(kernel: KernelClient, onCleanupError: () => void = () => {}, requireOwner?: (scope: UiBranchScope) => Promise<void>) {
  const activity = createUiActivity();
  const guarded = <A extends unknown[], R>(action: (root: string, ...args: A) => Promise<R>) =>
    (root: string, ...args: A): Promise<R> => activity.run(root, () => action(root, ...args));
  const clients = new Map<string, Promise<KernelScopedClient>>();
  const connection = (scope: string) => {
    let pending = clients.get(scope);
    if (!pending) {
      pending = kernel.issueGrant({ grantId: `ui:${randomUUID()}`, owningWorkspace: scope, executionWorkspace: scope,
        capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }).then(grant => kernel.scoped(grant))
        .catch(error => { clients.delete(scope); throw error; });
      clients.set(scope, pending);
    }
    return pending;
  };
  const workspace = (rootThreadId: string) => `__varin_ui__:${rootThreadId}`;
  const get = async (root: string, id: string) => (await connection(workspace(root))).getRecord(workspace(root), id);
  const put = async (root: string, id: string, type: string, value: object, operationId: string,
    refs: { slot: string; objectHash: string }[] = [], owners: string[] = [], expectedRecordRevision?: number) =>
    (await connection(workspace(root))).putRecord({ workspaceId: workspace(root), recordId: id, recordType: type,
      state: 'active', payloadJson: JSON.stringify(value), operationId, references: refs, ownerIds: owners,
      ...(expectedRecordRevision === undefined ? {} : { expectedRecordRevision }) });
  const bytes = async (root: string, record: string, object: FileObject) => {
    const client = await connection(workspace(root));
    const chunks: Buffer[] = []; let offset = 0;
    for (;;) {
      const slice = await client.getBlob(object.hash, { recordId: record, slot: object.slot }, { offset });
      chunks.push(Buffer.from(slice.bytesBase64, 'base64'));
      if (slice.eof) break;
      if (slice.nextOffset <= offset) throw new Error('UI content reader did not advance');
      offset = slice.nextOffset;
    }
    return Buffer.concat(chunks);
  };
  const resolve = async (root: string, ref: string) => {
    const match = /^ui:([a-zA-Z0-9_-]+)(?:@([1-9]\d*))?$/.exec(ref);
    if (!match) throw new UiContentError('Invalid work reference');
    const record = await get(root, `ui:${match[1]}`);
    if (!record) throw new UiContentError('Work is unavailable in this conversation', 404);
    const document = JSON.parse(record.payloadJson) as Work;
    const version = match[2] ? document.versions.find(v => v.revision === Number(match[2])) : document.versions.at(-1);
    if (!version) throw new UiContentError('Revision does not exist', 404);
    return { record, document, version };
  };
  const source = async (root: string, ref: string): Promise<UiSource> => {
    const { record, version } = await resolve(root, ref);
    const contents = Object.fromEntries(await Promise.all(Object.entries(version.files).map(async ([file, object]) =>
      [file, (await bytes(root, record.recordId, object)).toString('utf8')])));
    const assets = Object.fromEntries(await Promise.all(Object.entries(version.assets).map(async ([ref, object]) =>
      [ref, { mimeType: object.mimeType, data: (await bytes(root, record.recordId, object)).toString('base64') }])));
    return { ...receipt(version), contents, assets, ...(version.branchScope ? { branchScope: version.branchScope } : {}), ...(version.forkedFrom ? { forkedFrom: version.forkedFrom } : {}), ...(version.content ? { content: version.content, definition: version.definition } : {}), ...(version.messageFragment ? { messageFragment: version.messageFragment } : {}) };
  };
  const operationReceipt = async (root: string, origin: string): Promise<UiReceipt | null> => {
    const operation = await (await connection(workspace(root))).getOperation(`ui-render:${hash(origin)}`);
    if (!operation || operation.state !== 'committed') return null;
    const record = operation.result as KernelRecordResult;
    const saved = (JSON.parse(record.payloadJson) as Work).mutation.receipt;
    if (saved.kind !== 'ui' || saved.workRef !== record.recordId) throw new UiContentError('Original UI operation receipt is invalid');
    return saved;
  };
  const locks = new Map<string, Promise<unknown>>();
  const render = async (root: string, input: RenderUiInput, origin: string,
    readMedia?: (resourceId: string) => Promise<{ mimeType: string; bytes: Uint8Array }>, messageFragment?: UiMessageFragment, branchScope?: UiBranchScope, forkedFrom?: string): Promise<UiReceipt> => {
    if ((input.changes !== undefined) === (input.content !== undefined)) throw new UiContentError('Supply exactly one of changes or content');
    if (input.changes !== undefined && !Array.isArray(input.changes)) throw new UiContentError('changes must be an array');
    let content: ConversationUiNode | undefined;
    try { if (input.content !== undefined) content = normalizeConversationUi(input.content); }
    catch (error) { throw new UiContentError(error instanceof Error ? error.message : 'Invalid content'); }
    // Capture the base at admission, before joining this work's commit sequence.
    const base = input.ref ? await resolve(root, input.ref) : null;
    const owner = branchScope ?? messageFragment ?? base?.version.branchScope ?? base?.version.messageFragment;
    if (owner) await requireOwner?.(owner);
    if (base && Boolean(base.version.content) !== Boolean(content)) throw new UiContentError('A work cannot change between HTML and declarative content');
    const id = base?.version.workRef ?? `ui:${hash(origin).slice(0, 32)}`;
    const operationId = `ui-render:${hash(origin)}`;
    const intent = canonical(input);
    const client = await connection(workspace(root));
    const replay = async () => {
      const operation = await client.getOperation(operationId);
      if (!operation) return null;
      if (operation.state !== 'committed') throw new UiContentError('Original content mutation did not commit; use a new call', 409);
      const result = operation.result as KernelRecordResult;
      if (result.recordId !== id) throw new UiContentError('Content operation belongs to another work', 409);
      const mutation = (JSON.parse(result.payloadJson) as Work).mutation;
      if (mutation.intent !== intent) throw new UiContentError('Original call has different arguments', 409);
      return mutation.receipt;
    };
    const previous = await replay(); if (previous) return previous;
    const task = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const repeated = await replay(); if (repeated) return repeated;
      const current = await get(root, id);
      const latest = current ? JSON.parse(current.payloadJson) as Work : null;
      if (latest?.versions.at(-1)?.ref !== base?.version.ref) throw new UiContentError('Work changed; read the latest revision before editing', 409);
      if (base && base.version.revision !== base.document.versions.at(-1)!.revision) throw new UiContentError('Work changed since this revision', 409);
      const paths = new Set(Object.keys(base?.version.files ?? {})), changedText = new Map<string, string>();
      const text = async (file: string) => {
        if (changedText.has(file)) return changedText.get(file)!;
        const object = base?.version.files[file];
        return object ? (await bytes(root, id, object)).toString('utf8') : '';
      };
      for (const change of input.changes ?? []) {
        const file = uiPath(change.file);
        if (change.op === 'write') { paths.add(file); changedText.set(file, change.text); }
        else if (change.op === 'append') { changedText.set(file, (paths.has(file) ? await text(file) : '') + change.text); paths.add(file); }
        else if (change.op === 'delete') { if (!paths.delete(file)) throw new UiContentError(`File not found: ${file}`, 404); changedText.delete(file); }
        else if (change.op === 'edit') { if (!paths.has(file)) throw new UiContentError(`File not found: ${file}`, 404); changedText.set(file, applyUiEdits(await text(file), change.edits)); }
      }
      const title = input.title ?? base?.version.title ?? '交互内容';
      if (content && input.entry !== undefined) throw new UiContentError('Declarative content does not have an HTML entry');
      const entry = content ? '' : uiPath(input.entry ?? base?.version.entry ?? 'index.html');
      const changed = !base || canonical(content ?? null) !== canonical(base.version.content ?? null) || title !== base.version.title || entry !== base.version.entry
        || paths.size !== Object.keys(base.version.files).length || [...paths].some(file => !base.version.files[file]
          || changedText.has(file) && base.version.files[file]!.hash !== `sha256-${hash(changedText.get(file)!)}`);
      const versions = base ? [...base.document.versions] : [];
      const owners: string[] = [];
      try {
        if (changed) {
          const revision = (base?.version.revision ?? 0) + 1;
          const files: Record<string, FileObject> = Object.create(null);
          for (const file of paths) {
            const value = changedText.get(file), original = base?.version.files[file];
            if (original && (value === undefined || original.hash === `sha256-${hash(value)}`)) files[file] = original;
            else {
              const blob = await client.putBlob(Buffer.from(value!), `${operationId}:file:${hash(file)}`);
              owners.push(blob.ownerId); files[file] = { hash: blob.hash, slot: `r${revision}:${file}`,
                mediaRefs: [...new Set([...value!.matchAll(/\bmedia:(media-[a-zA-Z0-9-]+)/g)].map(match => match[0]))] };
            }
          }
          const assets: Revision['assets'] = Object.create(null);
          for (const ref of new Set(Object.values(files).flatMap(file => file.mediaRefs ?? []))) {
            const previous = base?.version.assets[ref];
            if (previous) { assets[ref] = previous; continue; }
            if (!readMedia) throw new UiContentError('Media resource owner is unavailable');
            const image = await readMedia(ref.slice('media:'.length));
            const blob = await client.putBlob(image.bytes, `${operationId}:asset:${hash(ref)}`);
            owners.push(blob.ownerId); assets[ref] = { hash: blob.hash, slot: `r${revision}:asset:${ref}`, mimeType: image.mimeType };
          }
          versions.push({ ref: `${id}@${revision}`, workRef: id, title, entry, revision, files, assets,
            ...(content ? { content, definition: input.content } : {}),
            ...((forkedFrom ?? base?.version.forkedFrom) ? { forkedFrom: (forkedFrom ?? base?.version.forkedFrom)! } : {}),
            ...((branchScope ?? base?.version.branchScope ?? messageFragment) ? { branchScope: { threadId: (branchScope ?? base?.version.branchScope ?? messageFragment)!.threadId, branchId: (branchScope ?? base?.version.branchScope ?? messageFragment)!.branchId } } : {}), ...((messageFragment ?? base?.version.messageFragment) ? { messageFragment: (messageFragment ?? base?.version.messageFragment)! } : {}) });
        }
        const result = receipt(versions.at(-1)!);
        const document: Work = { versions, mutation: { intent, receipt: result } };
        const refs = new Map(versions.flatMap(version => [...Object.values(version.files), ...Object.values(version.assets)].map(object => [object.slot, object.hash] as const)));
        try { await put(root, id, 'ui.work', document, operationId, [...refs].map(([slot, objectHash]) => ({ slot, objectHash })), owners, current?.recordRevision); }
        catch {
          try { const committed = await replay(); if (committed) return committed; }
          catch (error) { if (error instanceof UiContentError && error.status === 409) throw error; }
          throw new UiMutationUnknownError();
        }
        return result;
      } finally { const cleanup = await Promise.allSettled(owners.map(owner => client.releaseBlob(owner))); if (cleanup.some(value => value.status === 'rejected')) onCleanupError(); }
    });
    locks.set(id, task);
    try { return await task; } finally { if (locks.get(id) === task) locks.delete(id); }
  };
  const viewRecord = async (root: string, ref: string) => {
    if (!/^ui-view:[a-zA-Z0-9-]+$/.test(ref)) throw new UiContentError('Invalid view reference');
    return get(root, ref);
  };
  const view = async (root: string, ref: string) => {
    const record = await viewRecord(root, ref); return record ? JSON.parse(record.payloadJson) as ViewRecord : null;
  };
  const saveView = async (root: string, ref: string, patch: { branchScope?: UiBranchScope; source?: UiSourceIdentity; state?: UiViewState | null; lease?: { token: string; clientId: string } | null }, expectedLease?: string) => {
    const key = `${root}:${ref}`;
    const task = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const record = await viewRecord(root, ref), previous = record ? JSON.parse(record.payloadJson) as ViewRecord : null;
      const owner = patch.branchScope ?? previous?.branchScope;
      if (owner) await requireOwner?.(owner);
      if (expectedLease !== undefined && previous?.lease?.token !== expectedLease) throw new UiContentError('View connection changed', 409);
      let source = patch.source ?? previous?.source;
      if (source?.preview) source = { preview: { ...source.preview, contents: {} } };
      const value = { ...((patch.lease?.clientId ?? previous?.clientId ?? previous?.lease?.clientId) ? { clientId: (patch.lease?.clientId ?? previous?.clientId ?? previous?.lease?.clientId)! } : {}), ...((patch.branchScope ?? previous?.branchScope) ? { branchScope: (patch.branchScope ?? previous?.branchScope)! } : {}), source, state: patch.state === undefined ? previous?.state ?? null : patch.state,
        lease: patch.lease === undefined ? previous?.lease ?? null : patch.lease };
      if (!value.source) throw new UiContentError('View has no source');
      if (value.source.ref) await resolve(root, value.source.ref);
      const operationId = `ui-view:${randomUUID()}`;
      await put(root, ref, 'ui.view', value, operationId, [], [], record?.recordRevision);
      await (await connection(workspace(root))).releaseOperation(operationId).catch(onCleanupError);
      return value;
    });
    locks.set(key, task);
    try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
  };
  const snapshot = async (root: string, observation: UiObservation, branchScope?: UiBranchScope, selectionOwned = false) => {
    branchScope ??= (await view(root, observation.viewRef))?.branchScope;
    if (branchScope) await requireOwner?.(branchScope);
    if (observation.ref && observation.preview) throw new UiContentError('Observation must have exactly one source');
    if (observation.preview?.content) {
      try { observation = { ...observation, preview: { ...observation.preview, content: normalizeConversationUi(observation.preview.content) } }; }
      catch { throw new UiContentError('Invalid declarative preview'); }
    }
    if (observation.ref) { const selected = await resolve(root, observation.ref); observation = { ...observation, ref: selected.version.ref }; }
    else if (!observation.preview) throw new UiContentError('Observation has no source');
    const id = `ui-snapshot:${randomUUID()}`;
    const client = await connection(workspace(root));
    const { image, preview, ...value } = observation;
    let object: FileObject | undefined;
    const owners: string[] = [], refs: { slot: string; objectHash: string }[] = [];
    const files: Record<string, FileObject> = Object.create(null);
    try {
      for (const [file, text] of Object.entries(preview?.contents ?? {})) {
        const blob = await client.putBlob(Buffer.from(text), `${id}:source:${hash(file)}`);
        owners.push(blob.ownerId); files[file] = { hash: blob.hash, slot: `source:${file}` }; refs.push({ slot: `source:${file}`, objectHash: blob.hash });
      }
      if (image) {
        const blob = await client.putBlob(Buffer.from(image.data, 'base64'), `${id}:image`);
        owners.push(blob.ownerId); object = { hash: blob.hash, slot: 'image' }; refs.push({ slot: 'image', objectHash: blob.hash });
      }
      await put(root, id, 'ui.snapshot', { ...value, ...(selectionOwned ? { selectionOwned: true } : {}), ...(branchScope ? { branchScope } : {}),
        ...(preview ? { preview: { provenance: 'client-preview', callId: preview.callId, sequence: preview.sequence, baseRef: preview.baseRef, entry: preview.entry, title: preview.title, files, ...(preview.content ? { content: preview.content } : {}), ...(preview.messageFragment ? { messageFragment: preview.messageFragment } : {}) } } : {}),
        ...(image ? { image: { ...object, mimeType: image.mimeType, method: image.method, capturedAt: image.capturedAt, bounds: image.bounds } } : {}) }, id, refs, owners);
      return id;
    } finally { const cleanup = await Promise.allSettled(owners.map(owner => client.releaseBlob(owner))); if (cleanup.some(value => value.status === 'rejected')) onCleanupError(); }
  };
  const readSnapshot = async (root: string, ref: string): Promise<UiObservation> => {
    if (!/^ui-snapshot:[a-zA-Z0-9-]+$/.test(ref)) throw new UiContentError('Invalid snapshot reference');
    const record = await get(root, ref); if (!record) throw new UiContentError('Snapshot is unavailable', 404);
    const value = JSON.parse(record.payloadJson) as Omit<UiObservation, 'image' | 'preview'> & {
      image?: FileObject & { mimeType: 'image/png'; method: 'screen' | 'dom'; capturedAt?: string; bounds?: NonNullable<UiObservation['image']>['bounds'] };
      preview?: Omit<NonNullable<UiObservation['preview']>, 'contents'> & { files: Record<string, FileObject> };
    };
    const { image, preview, selectionOwned: _selectionOwned, ...rest } = value as typeof value & { selectionOwned?: boolean };
    const contents = Object.fromEntries(await Promise.all(Object.entries(preview?.files ?? {}).map(async ([file, object]) => [file, (await bytes(root, ref, object)).toString('utf8')])));
    return { ...rest, ...(preview ? { preview: { callId: preview.callId, sequence: preview.sequence, entry: preview.entry, title: preview.title,
      ...(preview.baseRef ? { baseRef: preview.baseRef } : {}), ...(preview.content ? { content: preview.content } : {}), ...(preview.messageFragment ? { messageFragment: preview.messageFragment } : {}), contents } } : {}),
      ...(image ? { image: { mimeType: image.mimeType, method: image.method, ...(image.capturedAt ? { capturedAt: image.capturedAt } : {}), ...(image.bounds ? { bounds: image.bounds } : {}), data: (await bytes(root, ref, image)).toString('base64') } } : {}) };
  };
  const select = async (root: string, observation: UiObservation, selected: { text?: string; region?: UiSelection['region'] }, branchScope?: UiBranchScope): Promise<UiSelection> => {
    branchScope ??= (await view(root, observation.viewRef))?.branchScope;
    const snapshotRef = await snapshot(root, observation, branchScope, true);
    const ref = `ui-selection:${randomUUID()}`;
    await put(root, ref, 'ui.selection', { snapshotRef, ...selected, ...(branchScope ? { branchScope } : {}) }, ref);
    return selection(root, ref);
  };
  const selection = async (root: string, ref: string): Promise<UiSelection> => {
    if (!/^ui-selection:[a-zA-Z0-9-]+$/.test(ref)) throw new UiContentError('Invalid selection reference');
    const record = await get(root, ref); if (!record) throw new UiContentError('Selection is unavailable', 404);
    const saved = JSON.parse(record.payloadJson) as { snapshotRef: string; text?: string; region?: UiSelection['region'] };
    const observed = await readSnapshot(root, saved.snapshotRef);
    const title = observed.ref ? (await resolve(root, observed.ref)).version.title : observed.preview!.title;
    return { ref, viewRef: observed.viewRef, snapshotRef: saved.snapshotRef, ...(saved.text === undefined ? {} : { text: saved.text }), ...(saved.region ? { region: saved.region } : {}), title, source: { ...(observed.ref ? { ref: observed.ref } : { preview: { ...observed.preview!, contents: {} } }) },
      ...(observed.image ? { image: observed.image } : {}), ...(observed.structure ? { structure: saved.region ? observed.structure.filter(node => {
        const a = node.bounds, b = saved.region!;
        return a.x < b.x + b.width && a.y < b.y + b.height && a.x + a.width > b.x && a.y + a.height > b.y;
      }) : observed.structure } : {}) };
  };
  const releaseSelection = async (root: string, ref: string, scope: UiBranchScope) => {
    if (!/^ui-selection:[a-zA-Z0-9-]+$/.test(ref)) throw new UiContentError('Invalid selection reference');
    const key = `${root}:${ref}`;
    const task = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const record = await get(root, ref);
      if (!record) return; // Replaying a retirement after physical collection is harmless.
      const saved = JSON.parse(record.payloadJson) as { branchScope?: UiBranchScope; released?: boolean };
      if (!saved.branchScope || canonical(saved.branchScope) !== canonical(scope)) throw new UiContentError('Selection belongs to another conversation branch', 403);
      if (saved.released) return;
      // This drops the draft root only. Catalog history/queue roots are traced before deletion.
      await put(root, ref, 'ui.selection', { ...saved, released: true }, `ui-selection-release:${ref}`, record.references, [], record.recordRevision);
    });
    locks.set(key, task);
    try { await task; } finally { if (locks.get(key) === task) locks.delete(key); }
    return { released: true as const };
  };
  const hasReleasedSelections = async (root: string) => {
    let cursor: number | undefined;
    do {
      const page = await (await connection(workspace(root))).listRecords({ workspaceId: workspace(root), recordType: 'ui.selection', ...(cursor === undefined ? {} : { cursor }) });
      if (page.records.some(record => { const value = JSON.parse(record.payloadJson) as { released?: boolean; retirementChecked?: boolean }; return value.released && !value.retirementChecked; })) return true;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return false;
  };
  type BranchCapture = { kind: 'branch-state'; source: UiBranchScope; target: UiBranchScope; headId: string | null; capturedAt: string;
    views: { clientId: string; viewRef: string; sourceRef: string; confirmedAt: number; fragment?: UiMessageFragment; content?: ConversationUiNode; state: UiViewState }[] };
  const captureId = (target: UiBranchScope) => `ui-branch-state:${hash(canonical(target))}`;
  const captureBranch = async (root: string, from: UiBranchScope, target: UiBranchScope, headId: string | null, containsMessage: (messageId: string) => boolean, containsRevision: (ref: string) => boolean = () => false) => {
    await requireOwner?.(from);
    const id = captureId(target), key = `${root}:${id}`;
    const work = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const existing = await get(root, id);
      if (existing) {
        const capture = JSON.parse(existing.payloadJson) as BranchCapture;
        if (canonical(capture.source) !== canonical(from) || capture.headId !== headId) throw new UiContentError('Fork capture belongs to another source', 409);
        return;
      }
      const captured: BranchCapture = { kind: 'branch-state', source: from, target, headId, capturedAt: new Date().toISOString(), views: [] };
      const client = await connection(workspace(root)); let cursor: number | undefined;
      do {
        const page = await client.listRecords({ workspaceId: workspace(root), recordType: 'ui.view', ...(cursor === undefined ? {} : { cursor }) });
        for (const record of page.records) {
          if (record.state !== 'active') continue;
          const saved = JSON.parse(record.payloadJson) as ViewRecord;
          const clientId = saved.clientId ?? saved.lease?.clientId;
          if (!saved.state || !clientId || !saved.source.ref || saved.branchScope?.threadId !== from.threadId || saved.branchScope.branchId !== from.branchId) continue;
          const original = (await resolve(root, saved.source.ref)).version;
          const fragment = original.content && original.messageFragment && containsMessage(original.messageFragment.messageId)
            && (original.revision === 1 && !original.forkedFrom || containsRevision(original.ref)) ? original.messageFragment : undefined;
          if (!fragment && !containsRevision(original.ref)) continue;
          captured.views.push({ clientId, viewRef: record.recordId, sourceRef: original.ref, confirmedAt: record.updatedAt,
            ...(fragment ? { fragment } : {}), ...(original.content ? { content: original.content } : {}), state: saved.state });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      // Existing ui.snapshot authority, not a parallel state writer. This immutable capture
      // precedes Catalog's fork; only an existing target branch can later attach a view.
      await put(root, id, 'ui.snapshot', captured, id);
    });
    locks.set(key, work);
    try { await work; } finally { if (locks.get(key) === work) locks.delete(key); }
  };
  const branchSeed = async (root: string, target: UiBranchScope, sourceIdentity: UiSourceIdentity, clientId: string): Promise<UiViewState | null> => {
    if (!sourceIdentity.ref) return null;
    const record = await get(root, captureId(target)); if (!record) return null;
    const capture = JSON.parse(record.payloadJson) as BranchCapture;
    if (capture.kind !== 'branch-state' || canonical(capture.target) !== canonical(target)) throw new UiContentError('Invalid branch state capture');
    const current = (await resolve(root, sourceIdentity.ref)).version, fragment = current.messageFragment;
    const matches = capture.views.filter(view => view.clientId === clientId && (fragment && current.content
      ? view.fragment?.messageId === fragment.messageId && view.fragment.fragmentKey === fragment.fragmentKey
        && (view.fragment.contentIndex ?? 0) === (fragment.contentIndex ?? 0) && view.fragment.contentVersion === fragment.contentVersion
      : view.sourceRef === current.ref && Boolean(view.content) === Boolean(current.content)));
    // Multiple independent views can have different explorations. Never select an arbitrary one.
    if (matches.length !== 1) return null;
    const seed = matches[0]!, data = seed.state.data;
    if (!current.content || !seed.content) return seed.state;
    const migrated = migrateConversationUiState(seed.content, current.content, data && typeof data === 'object' && !Array.isArray(data) ? data : {});
    return { ...seed.state, data: migrated.values, controls: { ...seed.state.controls, __varinResetKeys: migrated.resetKeys } };
  };
  const collectFamilies = (roots: readonly string[], plan: () => Promise<MaterialRetention>, signal?: AbortSignal) => {
    const ordered = [...new Set(roots)].sort();
    const enter = async (index: number): Promise<void> => {
      signal?.throwIfAborted();
      const root = ordered[index];
      if (root !== undefined) return activity.exclusive(root, () => Promise.resolve().then(() => enter(index + 1)));
      // Capture once after all candidate writes have settled, not once per family.
      const retained = await plan();
      for (const family of ordered) await releaseUiRecords(await connection(workspace(family)), workspace(family), retained, signal);
    };
    return enter(0);
  };
  return { source: guarded(source), render: guarded(render), resolve: guarded(resolve), view: guarded(view), saveView: guarded(saveView),
    snapshot: guarded(snapshot), operationReceipt: guarded(operationReceipt), captureBranch: guarded(captureBranch), branchSeed: guarded(branchSeed), readSnapshot: guarded(readSnapshot), select: guarded(select), selection: guarded(selection), releaseSelection: guarded(releaseSelection), hasReleasedSelections: guarded(hasReleasedSelections),
    cleanup: (root: string, signal?: AbortSignal) => activity.exclusive(root, async () =>
      (await connection(workspace(root))).uiCleanup(workspace(root), signal)),
    collect: (root: string, plan: MaterialRetention | (() => Promise<MaterialRetention>), signal?: AbortSignal) => activity.exclusive(root, async () =>
      releaseUiRecords(await connection(workspace(root)), workspace(root), typeof plan === 'function' ? await plan() : plan, signal)),
    collectFamilies,
    file: guarded(async (root: string, ref: string, file: string) => { const { record, version } = await resolve(root, ref); const object = version.files[file];
      if (!object) throw new UiContentError('Work file not found', 404); return (await bytes(root, record.recordId, object)).toString('utf8'); }),
  };
}
export type UiContentStore = ReturnType<typeof createUiContentStore>;
