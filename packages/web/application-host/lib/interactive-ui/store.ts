import { createHash, randomUUID } from 'node:crypto';
import type { RenderUiInput, UiReceipt, UiSource, UiObservation, UiSelection, UiViewState, UiSourceIdentity } from '@varin/application-client';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';

/** code names a public, stable reason that survives the generic resource wrapper. */
export class UiContentError extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); } }
export class UiMutationUnknownError extends UiContentError { constructor() { super('Save outcome is not confirmed; the original call was not repeated', 503); } }
type FileObject = { hash: string; slot: string; mediaRefs?: string[] };
type Revision = Omit<UiReceipt, 'kind' | 'files'> & { files: Record<string, FileObject>; assets: Record<string, FileObject & { mimeType: string }> };
export interface Work { versions: Revision[]; mutation: { intent: string; receipt: UiReceipt } }
export interface ViewRecord { source: UiSourceIdentity; state: UiViewState | null; lease?: { token: string; clientId: string } | null }
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
export function createUiContentStore(kernel: KernelClient, onCleanupError: () => void = () => {}) {
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
    return { ...receipt(version), contents, assets };
  };
  const locks = new Map<string, Promise<unknown>>();
  const render = async (root: string, input: RenderUiInput, origin: string,
    readMedia?: (resourceId: string) => Promise<{ mimeType: string; bytes: Uint8Array }>): Promise<UiReceipt> => {
    // Capture the base at admission, before joining this work's commit sequence.
    const base = input.ref ? await resolve(root, input.ref) : null;
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
      for (const change of input.changes) {
        const file = uiPath(change.file);
        if (change.op === 'write') { paths.add(file); changedText.set(file, change.text); }
        else if (change.op === 'append') { changedText.set(file, (paths.has(file) ? await text(file) : '') + change.text); paths.add(file); }
        else if (change.op === 'delete') { if (!paths.delete(file)) throw new UiContentError(`File not found: ${file}`, 404); changedText.delete(file); }
        else if (change.op === 'edit') { if (!paths.has(file)) throw new UiContentError(`File not found: ${file}`, 404); changedText.set(file, applyUiEdits(await text(file), change.edits)); }
      }
      const title = input.title ?? base?.version.title ?? '交互内容';
      const entry = uiPath(input.entry ?? base?.version.entry ?? 'index.html');
      const changed = !base || title !== base.version.title || entry !== base.version.entry
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
          versions.push({ ref: `${id}@${revision}`, workRef: id, title, entry, revision, files, assets });
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
  const saveView = async (root: string, ref: string, patch: { source?: UiSourceIdentity; state?: UiViewState | null; lease?: { token: string; clientId: string } | null }, expectedLease?: string) => {
    const key = `${root}:${ref}`;
    const task = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const record = await viewRecord(root, ref), previous = record ? JSON.parse(record.payloadJson) as ViewRecord : null;
      if (expectedLease !== undefined && previous?.lease?.token !== expectedLease) throw new UiContentError('View connection changed', 409);
      let source = patch.source ?? previous?.source;
      if (source?.preview) source = { preview: { ...source.preview, contents: {} } };
      const value = { source, state: patch.state === undefined ? previous?.state ?? null : patch.state,
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
  const snapshot = async (root: string, observation: UiObservation) => {
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
      await put(root, id, 'ui.snapshot', { ...value,
        ...(preview ? { preview: { callId: preview.callId, sequence: preview.sequence, baseRef: preview.baseRef, entry: preview.entry, title: preview.title, files } } : {}),
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
    const { image, preview, ...rest } = value;
    const contents = Object.fromEntries(await Promise.all(Object.entries(preview?.files ?? {}).map(async ([file, object]) => [file, (await bytes(root, ref, object)).toString('utf8')])));
    return { ...rest, ...(preview ? { preview: { callId: preview.callId, sequence: preview.sequence, entry: preview.entry, title: preview.title,
      ...(preview.baseRef ? { baseRef: preview.baseRef } : {}), contents } } : {}),
      ...(image ? { image: { mimeType: image.mimeType, method: image.method, ...(image.capturedAt ? { capturedAt: image.capturedAt } : {}), ...(image.bounds ? { bounds: image.bounds } : {}), data: (await bytes(root, ref, image)).toString('base64') } } : {}) };
  };
  const select = async (root: string, observation: UiObservation, selected: { text?: string; region?: UiSelection['region'] }): Promise<UiSelection> => {
    const snapshotRef = await snapshot(root, observation);
    const ref = `ui-selection:${randomUUID()}`;
    await put(root, ref, 'ui.selection', { snapshotRef, ...selected }, ref);
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
  return { source, render, resolve, view, saveView, snapshot, readSnapshot, select, selection,
    async file(root: string, ref: string, file: string) { const { record, version } = await resolve(root, ref); const object = version.files[file];
      if (!object) throw new UiContentError('Work file not found', 404); return (await bytes(root, record.recordId, object)).toString('utf8'); },
  };
}
export type UiContentStore = ReturnType<typeof createUiContentStore>;
