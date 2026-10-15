import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  VarinDocumentReadResult,
  VarinLanguageWorkspaceEdit,
  VarinResourceReference,
  VarinWorkspaceEditBuffer,
  VarinWorkspaceEditBufferSlot,
  VarinWorkspaceEditPrepareRequest,
  VarinWorkspaceEditPreparation,
  VarinWorkspaceEditPreviewFile,
  VarinWorkspaceEditReceipt,
  VarinWorkspaceEditSurfaceChange,
} from '@varin/application-client';
import type { DurableFileOperationContext, HostResourceOperation } from '../recovery/durable-file-operation.js';
import { sameState, type RecoveryState } from '../recovery/journal-files.js';
import { normalizeWorkspaceRelativePath } from '../workspace/path-safety.js';
import { detectLineEnding, normalizeEditorLineEndings } from './line-ending.js';
import { DocumentAuthorityError } from './errors.js';

export const WORKSPACE_EDIT_KIND = 'workspace-edit';
const missing: RecoveryState = { kind: 'missing' };
const emptyFile: RecoveryState = {
  kind: 'regular-file',
  byteLength: 0,
  objectHash: `sha256-${createHash('sha256').update('').digest('hex')}`,
};
const clone = <T>(value: T): T => structuredClone(value);
const matches = (expected: RecoveryState, actual: RecoveryState): boolean =>
  sameState('mode' in actual && !('mode' in expected) ? { ...expected, mode: actual.mode } : expected, actual);
const contains = (root: string, path: string) => root === path || path.startsWith(`${root}/`);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function fail(message: string): never {
  throw new DocumentAuthorityError(message, { code: 'stale-completion', statusCode: 409 });
}
const resource = (workspaceId: string, resourceId: string): VarinResourceReference => ({ workspaceId, resourceId });
const revision = (state: RecoveryState): string | null =>
  state.kind === 'regular-file'
    ? `d1_${Buffer.from(state.objectHash.slice('sha256-'.length), 'hex').toString('base64url')}`
    : null;

interface SurfaceOwner {
  ownerId: string;
  generation: number;
  registrationId: string;
}
interface SurfaceBaseline {
  owner: SurfaceOwner;
  buffers: VarinWorkspaceEditBufferSlot[];
}
interface DiskAction {
  kind: 'disk';
  before: Record<string, RecoveryState>;
  after: Record<string, RecoveryState>;
  rename?: { from: string; to: string; sameLocation?: boolean };
}
interface BufferAction {
  kind: 'buffer';
  owner: SurfaceOwner;
  before: VarinWorkspaceEditBufferSlot[];
  after: VarinWorkspaceEditBufferSlot[];
}
type Action = (DiskAction | BufferAction) & { step: number; id: string };
interface Plan {
  operationId: string;
  workspaceId: string;
  hostId: string;
  epoch: number;
  origin: string;
  root: string;
  scopes: HostResourceOperation[];
  resourceIdentities: Record<string, string>;
  initialDisk: Record<string, RecoveryState>;
  finalDisk: Record<string, RecoveryState>;
  initialBuffers: VarinWorkspaceEditBufferSlot[];
  surfaces: SurfaceBaseline[];
  previewSteps: number[];
  owner: SurfaceOwner | null;
  actions: Action[];
  preview: Extract<VarinWorkspaceEditPreparation, { status: 'ready' }>;
}
interface Execution {
  plan: Plan;
  receipt: VarinWorkspaceEditReceipt;
  /** Persist intent before dispatch. An intent alone is never a successful write. */
  bufferVersions?: Record<string, number>;
  actions: Array<'pending' | 'dispatched' | 'applied' | 'restored' | 'not-applied' | 'needs-attention'>;
}
export interface WorkspaceEditServices {
  hostId: string;
  storage<T>(workspaceId: string, callback: (context: DurableFileOperationContext) => Promise<T>): Promise<T>;
  resources<T>(workspaceId: string, scopes: readonly HostResourceOperation[], callback: () => Promise<T>): Promise<T>;
  inspect(workspaceId: string): Promise<{ root: string; epoch: number }>;
  owner(workspaceId: string, ownerId: string, generation: number): SurfaceOwner;
  read(resource: VarinResourceReference): Promise<VarinDocumentReadResult>;
  resolve(resource: VarinResourceReference): Promise<{ coordinationId: string }>;
  barrier(
    workspaceId: string,
    paths: string[]
  ): Promise<{ barrierId: string; settle(): Promise<void>; release(): Promise<void> }>;
  assertBarrier(barrierId: string): void;
  captureSurfaces(
    workspaceId: string,
    scopes: HostResourceOperation[],
    owner: SurfaceOwner | null,
    buffers: VarinWorkspaceEditBuffer[]
  ): Promise<SurfaceBaseline[]>;
  validateDirtyOwners(workspaceId: string, paths: string[], surfaces: SurfaceBaseline[]): Promise<void>;
  surface(
    workspaceId: string,
    owner: SurfaceOwner,
    barrierId: string,
    operationId: string,
    change: VarinWorkspaceEditSurfaceChange
  ): Promise<void>;
  mutate<T>(workspaceId: string, epoch: number, operationId: string, callback: () => Promise<T>): Promise<T>;
  notify(workspaceId: string, action: DiskAction, reversed: boolean, operationId: string): void;
}

const applyTextEdits = (
  text: string,
  edits: VarinLanguageWorkspaceEdit['documentChanges'][number] & { kind: 'text' }
): string => {
  const offset = (position: { line: number; character: number }): number => {
    if (
      !Number.isSafeInteger(position.line) ||
      !Number.isSafeInteger(position.character) ||
      position.line < 0 ||
      position.character < 0
    )
      fail('Text edit position is invalid');
    let start = 0;
    for (let line = 0; line < position.line; line++) {
      const end = text.indexOf('\n', start);
      if (end < 0) fail('Text edit line is outside the document');
      start = end + 1;
    }
    const end = text.indexOf('\n', start);
    if (position.character > (end < 0 ? text.length : end) - start) fail('Text edit character is outside the document');
    return start + position.character;
  };
  const changes = edits.edits.map((edit, index) => ({
    from: offset(edit.range.start),
    to: offset(edit.range.end),
    text: normalizeEditorLineEndings(edit.newText),
    index,
  }));
  const sorted = changes.sort((a, b) => a.from - b.from || a.to - b.to || a.index - b.index);
  for (let i = 0; i < sorted.length; i++)
    if (sorted[i]!.to < sorted[i]!.from || (i > 0 && sorted[i - 1]!.to > sorted[i]!.from))
      fail('Text edits have overlapping or reversed ranges');
  for (const change of sorted.reverse()) text = text.slice(0, change.from) + change.text + text.slice(change.to);
  return text;
};

const bufferVersionKey = (owner: SurfaceOwner, documentInstanceId: string) =>
  `${owner.ownerId}\0${owner.registrationId}\0${documentInstanceId}`;
const bufferSlot = (
  workspaceId: string,
  path: string,
  buffer?: VarinWorkspaceEditBuffer | null
): VarinWorkspaceEditBufferSlot => ({ resource: resource(workspaceId, path), buffer: buffer ? clone(buffer) : null });
const affectedPaths = (change: VarinLanguageWorkspaceEdit['documentChanges'][number]): string[] =>
  change.kind === 'rename' ? [change.from.resourceId, change.to.resourceId] : [change.resource.resourceId];
const hasDraft = (buffer: VarinWorkspaceEditBuffer | undefined) =>
  Boolean(buffer && buffer.buffer !== buffer.baseContent);

export const createWorkspaceEditCoordinator = (services: WorkspaceEditServices) => {
  let disposed = false;
  const plans = new Map<string, Plan>();
  const active = new Map<string, Promise<VarinWorkspaceEditReceipt>>();
  const key = (workspaceId: string, operationId: string) => `${workspaceId}\0${operationId}`;
  const requireFiles = (context: DurableFileOperationContext) => {
    if (!context.fileResources)
      throw new DocumentAuthorityError('The workspace file owner is unavailable', { code: 'failed', statusCode: 503 });
    return context.fileResources;
  };
  const capture = async (
    context: DurableFileOperationContext,
    paths: readonly string[],
    store = false
  ): Promise<Record<string, RecoveryState>> =>
    Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          (await context.fileStore.captureState(context.identity, context.root, path, { store })).state,
        ])
      )
    );
  const scan = async (context: DurableFileOperationContext, path: string): Promise<string[]> => {
    const state = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
    if (state.kind !== 'directory') return [path];
    const children = await requireFiles(context).scanPaths(context.identity, path, undefined, {
      includeInternalEntries: true,
    });
    return [path, ...children.map((child) => `${path}/${child}`)];
  };
  const verify = async (
    context: DurableFileOperationContext,
    expected: Record<string, RecoveryState>,
    scopes: readonly HostResourceOperation[] = []
  ): Promise<void> => {
    const observed = await capture(context, Object.keys(expected));
    for (const [path, state] of Object.entries(expected))
      if (!matches(state, observed[path]!)) fail(`Resource changed after preparation: ${path}`);
    for (const scope of scopes)
      if (scope.scope === 'subtree' && expected[scope.resourceId]?.kind === 'directory') {
        const actual = (await scan(context, scope.resourceId))
          .filter((path) => observed[path]?.kind !== 'missing')
          .sort();
        const planned = Object.keys(expected)
          .filter((path) => contains(scope.resourceId, path) && expected[path]!.kind !== 'missing')
          .sort();
        if (!isDeepStrictEqual(actual, planned))
          fail(`Directory entries changed after preparation: ${scope.resourceId}`);
      }
  };

  const prepare = async (request: VarinWorkspaceEditPrepareRequest): Promise<VarinWorkspaceEditPreparation> => {
    try {
      if (disposed) fail('Document authority is disposed');
      if (
        !request ||
        typeof request.operationId !== 'string' ||
        !request.operationId ||
        typeof request.origin !== 'string' ||
        !Array.isArray(request.edit?.documentChanges) ||
        (request.buffers !== undefined && !Array.isArray(request.buffers))
      )
        fail('Workspace edit request is malformed');
      const workspace = await services.inspect(request.workspaceId);
      if ((request.ownerId === undefined) !== (request.generation === undefined))
        fail('Workspace edit surface identity is incomplete');
      if (request.ownerId === undefined && request.buffers?.length)
        fail('Caller buffers require their actual surface owner');
      const requestedOwner =
        request.ownerId === undefined
          ? null
          : services.owner(request.workspaceId, request.ownerId, request.generation!);
      const input = { ...clone(request), buffers: clone(request.buffers ?? []) };
      const scopes = new Map<string, HostResourceOperation>();
      for (const change of input.edit.documentChanges) {
        if (!['text', 'create', 'rename', 'delete'].includes(change.kind)) fail('Unknown workspace edit operation');
        for (const target of change.kind === 'rename' ? [change.from, change.to] : [change.resource]) {
          if (target.workspaceId !== request.workspaceId) fail('Workspace edit targets another workspace');
          const normalized = normalizeWorkspaceRelativePath(target.resourceId);
          if (!normalized || normalized !== target.resourceId)
            fail('Workspace edit resource is not a normalized relative path');
          await services.resolve(target);
          const previous = scopes.get(normalized);
          scopes.set(normalized, {
            resourceId: normalized,
            scope: change.kind === 'text' && previous?.scope !== 'subtree' ? 'exact' : 'subtree',
          });
        }
      }
      for (const target of [...scopes.keys()]) {
        const pieces = target.split('/');
        while (pieces.length > 1) {
          pieces.pop();
          const parent = pieces.join('/');
          if (!scopes.has(parent)) scopes.set(parent, { resourceId: parent, scope: 'exact' });
        }
      }
      const participants = await services.captureSurfaces(
        request.workspaceId,
        [...scopes.values()],
        requestedOwner,
        input.buffers
      );
      const owner = requestedOwner ?? participants[0]?.owner ?? null;
      if (!owner && input.edit.documentChanges.some((change) => change.kind === 'text'))
        fail('No live document surface can retain the text edit');
      const plan = await services.storage(request.workspaceId, async (context) =>
        services.resources(request.workspaceId, [...scopes.values()], async () => {
          const routeDisk = new Map<string, RecoveryState>();
          for (const scope of scopes.values())
            for (const path of scope.scope === 'subtree' ? await scan(context, scope.resourceId) : [scope.resourceId]) {
              routeDisk.set(
                path,
                (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state
              );
            }
          // Text belongs to the actual draft owner. Different drafts at one path have
          // no single version to which an LSP TextDocumentEdit could safely apply.
          const routeBuffers = new Map(
            participants.map((surface) => [
              surface.owner.ownerId,
              new Map(
                surface.buffers.flatMap((slot) =>
                  slot.buffer ? [[slot.resource.resourceId, clone(slot.buffer)] as const] : []
                )
              ),
            ])
          );
          const textOwners = new Map<number, Set<string>>();
          for (const [step, change] of input.edit.documentChanges.entries()) {
            const path = affectedPaths(change)[0]!;
            const state = routeDisk.get(path) ?? missing;
            if (change.kind === 'create' && state.kind !== 'missing' && !change.overwrite && change.ignoreIfExists)
              continue;
            if (change.kind === 'delete' && state.kind === 'missing' && change.ignoreIfNotExists) continue;
            if (change.kind === 'rename') {
              const target = routeDisk.get(change.to.resourceId) ?? missing;
              const sameLocation =
                path.toLowerCase() === change.to.resourceId.toLowerCase() &&
                (await services.resolve(change.from)).coordinationId ===
                  (await services.resolve(change.to)).coordinationId;
              if (!sameLocation && target.kind !== 'missing' && !change.overwrite && change.ignoreIfExists) continue;
              const moved = [...routeDisk].filter(([key, value]) => contains(path, key) && value.kind !== 'missing');
              for (const key of [...routeDisk.keys()].filter(
                (key) => contains(change.to.resourceId, key) || contains(path, key)
              ))
                routeDisk.set(key, missing);
              for (const [key, value] of moved) routeDisk.set(change.to.resourceId + key.slice(path.length), value);
            } else if (change.kind === 'create') routeDisk.set(path, emptyFile);
            else if (change.kind === 'delete')
              for (const key of [...routeDisk.keys()].filter((key) => contains(path, key))) routeDisk.set(key, missing);
            if (change.kind === 'text') {
              const candidates = participants.filter((surface) => routeBuffers.get(surface.owner.ownerId)!.has(path));
              const dirty = candidates.filter((surface) =>
                hasDraft(routeBuffers.get(surface.owner.ownerId)!.get(path))
              );
              if (dirty.length > 1) {
                const states = dirty.map((surface) => routeBuffers.get(surface.owner.ownerId)!.get(path)!);
                if (
                  states.some(
                    (state) =>
                      state.buffer !== states[0]!.buffer ||
                      state.baseRevision !== states[0]!.baseRevision ||
                      state.localEditRevision !== states[0]!.localEditRevision
                  )
                )
                  fail(`Different drafts have no shared text version: ${path}`);
              }
              const selected = dirty.length
                ? dirty
                : candidates.some((surface) => surface.owner.ownerId === owner!.ownerId)
                  ? candidates.filter((surface) => surface.owner.ownerId === owner!.ownerId)
                  : candidates.slice(0, 1);
              const owners = new Set(
                selected.length ? selected.map((surface) => surface.owner.ownerId) : [owner!.ownerId]
              );
              textOwners.set(step, owners);
              for (const id of owners) {
                const before = routeBuffers.get(id)!.get(path);
                if (before)
                  routeBuffers
                    .get(id)!
                    .set(path, {
                      ...before,
                      buffer: applyTextEdits(before.buffer, change),
                      localEditRevision: before.localEditRevision + 1,
                    });
              }
            } else
              for (const buffers of routeBuffers.values()) {
                if (change.kind === 'rename') {
                  for (const key of [...buffers.keys()].filter((key) => contains(change.to.resourceId, key)))
                    buffers.delete(key);
                  for (const [key, buffer] of [...buffers].filter(([key]) => contains(path, key))) {
                    buffers.delete(key);
                    const destination = change.to.resourceId + key.slice(path.length);
                    buffers.set(destination, { ...buffer, resource: resource(request.workspaceId, destination) });
                  }
                } else if (change.kind === 'create') {
                  const before = buffers.get(path);
                  if (before) buffers.set(path, { ...before, buffer: '', baseContent: '' });
                }
              }
          }
          const prepared: Plan[] = [];
          for (const participant of participants.length ? participants : [{ owner: null, buffers: [] }]) {
            const owner = participant.owner;
            const input = {
              ...request,
              buffers: participant.buffers.flatMap((slot) => (slot.buffer ? [slot.buffer] : [])),
            };
            const candidate = await (async () => {
              const disk = new Map<string, RecoveryState>();
              const initialDisk: Record<string, RecoveryState> = {};
              const ensure = async (path: string) => {
                if (!disk.has(path)) {
                  const state = (
                    await context.fileStore.captureState(context.identity, context.root, path, { store: false })
                  ).state;
                  if (state.kind === 'unsupported') fail(`Unsupported filesystem entry: ${path}`);
                  disk.set(path, state);
                  initialDisk[path] = clone(state);
                }
              };
              for (const scope of scopes.values()) {
                for (const path of scope.scope === 'subtree'
                  ? await scan(context, scope.resourceId)
                  : [scope.resourceId])
                  await ensure(path);
              }
              // Parent creation is a real filesystem effect and belongs to the same undo.
              for (const path of [...disk.keys()]) {
                const pieces = path.split('/');
                while (pieces.length > 1) {
                  pieces.pop();
                  await ensure(pieces.join('/'));
                }
              }
              const buffers = new Map<string, VarinWorkspaceEditBuffer>();
              for (const buffer of input.buffers) {
                const path = buffer.resource.resourceId;
                if (
                  buffer.resource.workspaceId !== request.workspaceId ||
                  ![...scopes.values()].some((scope) =>
                    scope.scope === 'subtree' ? contains(scope.resourceId, path) : scope.resourceId === path
                  )
                )
                  continue;
                if (
                  buffers.has(path) ||
                  typeof buffer.documentInstanceId !== 'string' ||
                  !buffer.documentInstanceId ||
                  !Number.isSafeInteger(buffer.localEditRevision) ||
                  buffer.localEditRevision < 0 ||
                  typeof buffer.buffer !== 'string' ||
                  typeof buffer.baseContent !== 'string' ||
                  (buffer.baseRevision !== null && typeof buffer.baseRevision !== 'string') ||
                  buffer.encoding !== 'utf-8' ||
                  typeof buffer.bom !== 'boolean' ||
                  !['lf', 'crlf', 'cr'].includes(buffer.lineEnding) ||
                  !['ready', 'missing', 'deleted'].includes(buffer.status)
                )
                  fail(`Invalid editor state: ${path}`);
                buffers.set(path, clone(buffer));
                await ensure(path);
              }
              const initialBuffers = new Map<string, VarinWorkspaceEditBufferSlot>();
              for (const path of disk.keys())
                initialBuffers.set(path, bufferSlot(request.workspaceId, path, buffers.get(path)));
              const actions: Action[] = [];
              const files: VarinWorkspaceEditPreviewFile[] = [];
              const previewSteps: number[] = [];
              const pushFile = (step: number, file: VarinWorkspaceEditPreviewFile) => {
                previewSteps.push(step);
                files.push(file);
              };
              let requiresConfirmation = false;
              const diskAction = (
                step: number,
                before: Record<string, RecoveryState>,
                after: Record<string, RecoveryState>,
                rename?: DiskAction['rename']
              ) => {
                actions.push({
                  kind: 'disk',
                  id: `${request.operationId}:${actions.length}`,
                  step,
                  before: clone(before),
                  after: clone(after),
                  ...(rename ? { rename } : {}),
                });
                for (const [path, state] of Object.entries(after)) disk.set(path, clone(state));
              };
              const updateBuffers = (step: number, updates: Map<string, VarinWorkspaceEditBuffer | null>) => {
                const before = [...updates.keys()].map((path) =>
                  bufferSlot(request.workspaceId, path, buffers.get(path))
                );
                const after = [...updates].map(([path, buffer]) => bufferSlot(request.workspaceId, path, buffer));
                if (!isDeepStrictEqual(before, after)) {
                  if (!owner) fail('No live document surface can retain the buffer change');
                  actions.push({
                    kind: 'buffer',
                    id: `${request.operationId}:${actions.length}`,
                    step,
                    owner,
                    before,
                    after,
                  });
                }
                for (const [path, buffer] of updates)
                  if (buffer) buffers.set(path, clone(buffer));
                  else buffers.delete(path);
              };
              const parents = (step: number, path: string) => {
                const parts = path.split('/');
                const parents: string[] = [];
                while (parts.length > 1) {
                  parts.pop();
                  parents.unshift(parts.join('/'));
                }
                for (const parent of parents) {
                  const state = disk.get(parent)!;
                  if (state.kind === 'missing')
                    diskAction(step, { [parent]: state }, { [parent]: { kind: 'directory' } });
                  else if (state.kind !== 'directory') fail(`Parent is not a directory: ${parent}`);
                }
              };
              for (const [step, change] of input.edit.documentChanges.entries()) {
                if (change.kind === 'text' && !textOwners.get(step)?.has(owner!.ownerId)) continue;
                const annotationIds =
                  change.kind === 'text'
                    ? change.edits.flatMap((edit) => (edit.annotationId ? [edit.annotationId] : []))
                    : change.annotationId
                      ? [change.annotationId]
                      : [];
                for (const id of annotationIds) {
                  if (!input.edit.changeAnnotations?.[id]) fail(`Unknown change annotation: ${id}`);
                  if (input.edit.changeAnnotations?.[id]?.needsConfirmation) requiresConfirmation = true;
                }
                const path = affectedPaths(change)[0]!;
                const state = disk.get(path) ?? missing;
                if (change.kind === 'text') {
                  let before = buffers.get(path);
                  if (!before) {
                    if (state.kind === 'missing') fail(`Text edit targets a missing file: ${path}`);
                    // A moved or newly created file is read through its original content identity.
                    const sourcePath = Object.keys(initialDisk).find((candidate) =>
                      sameState(initialDisk[candidate]!, state)
                    );
                    const read = sourcePath ? await services.read(resource(request.workspaceId, sourcePath)) : null;
                    if (state.kind !== 'regular-file' || (read && read.status !== 'ready'))
                      fail(`Text edit targets a non-text file: ${path}`);
                    const text =
                      read?.status === 'ready'
                        ? normalizeEditorLineEndings(read.content)
                        : state.objectHash ===
                            (emptyFile as Extract<RecoveryState, { kind: 'regular-file' }>).objectHash
                          ? ''
                          : fail(`Text source is unavailable: ${path}`);
                    before = {
                      resource: resource(request.workspaceId, path),
                      documentInstanceId: randomUUID(),
                      localEditRevision: 0,
                      baseRevision: revision(state),
                      buffer: text,
                      baseContent: text,
                      encoding: read?.status === 'ready' ? read.encoding : 'utf-8',
                      bom: read?.status === 'ready' ? read.bom : false,
                      lineEnding: read?.status === 'ready' ? detectLineEnding(read.content) : 'lf',
                      status: 'ready',
                    };
                  }
                  if (before.status !== 'ready') fail(`Document is ${before.status}: ${path}`);
                  if (change.version !== null && change.version !== before.localEditRevision)
                    fail(`Document version changed: ${path}`);
                  const after = {
                    ...before,
                    buffer: applyTextEdits(before.buffer, change),
                    localEditRevision: before.localEditRevision + 1,
                  };
                  updateBuffers(step, new Map([[path, after]]));
                  pushFile(step, {
                    resource: after.resource,
                    kind: 'text',
                    beforeContent: before.buffer,
                    afterContent: after.buffer,
                    editCount: change.edits.length,
                    affectsDraft: hasDraft(before),
                    annotationIds,
                  });
                } else if (change.kind === 'create') {
                  if (state.kind !== 'missing' && !change.overwrite) {
                    if (change.ignoreIfExists) continue;
                    fail(`Create target exists: ${path}`);
                  }
                  if (state.kind === 'directory') fail(`Cannot create a file over a directory: ${path}`);
                  const before = buffers.get(path);
                  parents(step, path);
                  diskAction(step, { [path]: state }, { [path]: clone(emptyFile) });
                  if (before)
                    updateBuffers(
                      step,
                      new Map([
                        [
                          path,
                          {
                            ...before,
                            buffer: '',
                            baseContent: '',
                            baseRevision: revision(emptyFile),
                            encoding: 'utf-8',
                            bom: false,
                            lineEnding: 'lf',
                            status: 'ready',
                            localEditRevision: before.localEditRevision + 1,
                          },
                        ],
                      ])
                    );
                  requiresConfirmation ||= hasDraft(before);
                  pushFile(step, {
                    resource: change.resource,
                    kind: 'create',
                    beforeContent: before?.buffer ?? '',
                    afterContent: '',
                    editCount: 0,
                    affectsDraft: hasDraft(before),
                    annotationIds,
                  });
                } else if (change.kind === 'delete') {
                  if (state.kind === 'missing') {
                    if (change.ignoreIfNotExists) continue;
                    fail(`Delete target is missing: ${path}`);
                  }
                  const paths = [...disk.keys()].filter(
                    (candidate) => contains(path, candidate) && disk.get(candidate)!.kind !== 'missing'
                  );
                  if (!change.recursive && paths.length > 1) fail(`Directory is not empty: ${path}`);
                  const updates = new Map<string, VarinWorkspaceEditBuffer | null>();
                  for (const candidate of [...buffers.keys()].filter((candidate) => contains(path, candidate))) {
                    const before = buffers.get(candidate)!;
                    requiresConfirmation ||= hasDraft(before);
                    if (candidate !== path && hasDraft(before))
                      pushFile(step, {
                        resource: before.resource,
                        kind: 'delete',
                        beforeContent: before.buffer,
                        afterContent: '',
                        editCount: 0,
                        affectsDraft: true,
                        annotationIds,
                      });
                    updates.set(candidate, {
                      ...before,
                      baseRevision: null,
                      status: 'deleted',
                      localEditRevision: before.localEditRevision + 1,
                    });
                  }
                  for (const candidate of paths.sort((a, b) => b.split('/').length - a.split('/').length))
                    diskAction(step, { [candidate]: disk.get(candidate)! }, { [candidate]: missing });
                  updateBuffers(step, updates);
                  const before = updates.get(path);
                  pushFile(step, {
                    resource: change.resource,
                    kind: 'delete',
                    beforeContent: before?.buffer ?? '',
                    afterContent: '',
                    editCount: 0,
                    affectsDraft: [...updates.values()].some((value) => hasDraft(value ?? undefined)),
                    annotationIds,
                  });
                } else {
                  const to = change.to.resourceId;
                  if (path === to) continue;
                  if (contains(path, to) || contains(to, path))
                    fail('A directory cannot be renamed into itself or an ancestor');
                  if (state.kind === 'missing') fail(`Rename source is missing: ${path}`);
                  const target = disk.get(to) ?? missing;
                  const sameLocation =
                    path.toLowerCase() === to.toLowerCase() &&
                    (await services.resolve(change.from)).coordinationId ===
                      (await services.resolve(change.to)).coordinationId;
                  if (!sameLocation && target.kind !== 'missing' && !change.overwrite) {
                    if (change.ignoreIfExists) continue;
                    fail(`Rename target exists: ${to}`);
                  }
                  const sourcePaths = [...disk.keys()].filter(
                    (candidate) => contains(path, candidate) && disk.get(candidate)!.kind !== 'missing'
                  );
                  for (const source of sourcePaths) {
                    const destination = to + source.slice(path.length);
                    await ensure(destination);
                    if (!initialBuffers.has(destination))
                      initialBuffers.set(
                        destination,
                        bufferSlot(request.workspaceId, destination, buffers.get(destination))
                      );
                  }
                  const targetPaths = sameLocation
                    ? []
                    : [...disk.keys()].filter(
                        (candidate) => contains(to, candidate) && disk.get(candidate)!.kind !== 'missing'
                      );
                  for (const candidate of targetPaths.sort((a, b) => b.split('/').length - a.split('/').length))
                    diskAction(step, { [candidate]: disk.get(candidate)! }, { [candidate]: missing });
                  parents(step, to);
                  const before: Record<string, RecoveryState> = {};
                  const after: Record<string, RecoveryState> = {};
                  for (const source of sourcePaths) {
                    const destination = to + source.slice(path.length);
                    before[source] = disk.get(source)!;
                    before[destination] = disk.get(destination) ?? missing;
                    after[source] = sameLocation ? disk.get(source)! : missing;
                    after[destination] = disk.get(source)!;
                  }
                  diskAction(step, before, after, { from: path, to, ...(sameLocation ? { sameLocation: true } : {}) });
                  const updates = new Map<string, VarinWorkspaceEditBuffer | null>();
                  for (const candidate of [...buffers.keys()].filter((candidate) => contains(to, candidate))) {
                    const overwritten = buffers.get(candidate)!;
                    requiresConfirmation ||= hasDraft(overwritten);
                    if (hasDraft(overwritten))
                      pushFile(step, {
                        resource: overwritten.resource,
                        kind: 'delete',
                        beforeContent: overwritten.buffer,
                        afterContent: '',
                        editCount: 0,
                        affectsDraft: true,
                        annotationIds,
                      });
                    updates.set(candidate, null);
                  }
                  for (const candidate of [...buffers.keys()].filter((candidate) => contains(path, candidate))) {
                    const buffer = buffers.get(candidate)!;
                    const destination = to + candidate.slice(path.length);
                    updates.set(candidate, null);
                    updates.set(destination, { ...buffer, resource: resource(request.workspaceId, destination) });
                  }
                  updateBuffers(step, updates);
                  const moved = buffers.get(to);
                  pushFile(step, {
                    resource: change.to,
                    from: change.from,
                    kind: 'rename',
                    beforeContent: moved?.buffer ?? '',
                    afterContent: moved?.buffer ?? '',
                    editCount: 0,
                    affectsDraft: hasDraft(moved),
                    annotationIds,
                  });
                }
              }
              for (const path of Object.keys(initialDisk))
                if (!initialBuffers.has(path))
                  initialBuffers.set(
                    path,
                    bufferSlot(
                      request.workspaceId,
                      path,
                      input.buffers.find((buffer) => buffer.resource.resourceId === path)
                    )
                  );
              for (const action of actions)
                if (action.kind === 'disk')
                  for (const path of Object.keys(action.after)) {
                    const previous = scopes.get(path);
                    if (!previous || action.before[path]?.kind === 'missing')
                      scopes.set(path, { resourceId: path, scope: 'subtree' });
                  }
              // Parent paths join the original lease before execution, rather than being hidden side effects.
              for (const path of Object.keys(initialDisk))
                if (!scopes.has(path)) scopes.set(path, { resourceId: path, scope: 'exact' });
              return {
                operationId: request.operationId,
                workspaceId: request.workspaceId,
                hostId: services.hostId,
                epoch: workspace.epoch,
                resourceIdentities: Object.fromEntries(
                  await Promise.all(
                    Object.keys(initialDisk).map(async (path) => [
                      path,
                      (await services.resolve(resource(request.workspaceId, path))).coordinationId,
                    ])
                  )
                ),
                origin: request.origin,
                root: workspace.root,
                scopes: [...scopes.values()],
                initialDisk,
                finalDisk: Object.fromEntries(disk),
                initialBuffers: [...initialBuffers.values()],
                surfaces: owner ? [{ owner, buffers: [...initialBuffers.values()] }] : [],
                previewSteps,
                owner,
                actions,
                preview: {
                  status: 'ready' as const,
                  operationId: request.operationId,
                  workspaceId: request.workspaceId,
                  hostId: services.hostId,
                  epoch: workspace.epoch,
                  files,
                  requiresConfirmation,
                },
              } satisfies Plan;
            })();
            prepared.push(candidate);
          }
          const primary = prepared[0]!;
          const initialDisk: Record<string, RecoveryState> = {};
          for (const candidate of prepared)
            for (const [path, state] of Object.entries(candidate.initialDisk)) {
              if (initialDisk[path] && !sameState(initialDisk[path]!, state))
                fail(`Disk changed while preparing surfaces: ${path}`);
              initialDisk[path] = state;
            }
          const surfaces = participants.map((participant) => ({
            owner: participant.owner,
            buffers: Object.keys(initialDisk).map((path) =>
              bufferSlot(
                request.workspaceId,
                path,
                participant.buffers.find((slot) => slot.resource.resourceId === path)?.buffer
              )
            ),
          }));
          const previews = prepared
            .flatMap((candidate) =>
              candidate.preview.files.map((file, index) => ({ step: candidate.previewSteps[index]!, file }))
            )
            .sort((a, b) => a.step - b.step)
            .filter(
              (item, index, all) =>
                all.findIndex((other) => other.step === item.step && isDeepStrictEqual(other.file, item.file)) === index
            );
          const actions = prepared
            .flatMap((candidate, index) =>
              candidate.actions.filter((action) => index === 0 || action.kind === 'buffer')
            )
            .sort((a, b) => a.step - b.step || (a.kind === b.kind ? 0 : a.kind === 'disk' ? -1 : 1))
            .map((action, index) => ({ ...action, id: `${request.operationId}:${index}` }));
          return {
            ...primary,
            initialDisk,
            resourceIdentities: Object.assign({}, ...prepared.map((candidate) => candidate.resourceIdentities)),
            finalDisk: Object.assign({}, ...prepared.map((candidate) => candidate.finalDisk)),
            scopes: [...scopes.values()],
            surfaces,
            initialBuffers: surfaces.flatMap((surface) => surface.buffers),
            actions,
            previewSteps: previews.map((item) => item.step),
            preview: {
              ...primary.preview,
              requiresConfirmation: prepared.some((candidate) => candidate.preview.requiresConfirmation),
              files: previews.map((item) => item.file),
            },
          };
        })
      );
      const existing = await read({ workspaceId: request.workspaceId, operationId: request.operationId });
      if (existing.status !== 'missing') fail('This workspace edit operation already has a durable receipt');
      plans.set(key(request.workspaceId, request.operationId), plan);
      return clone(plan.preview);
    } catch (error) {
      return { status: 'rejected', failures: [{ reason: 'invalid-plan', message: errorText(error) }] };
    }
  };

  const operation = async (context: DurableFileOperationContext, operationId: string) => {
    const value = await context.durableRecoveryStore.getOperation(context.identity.workspaceId, operationId);
    if (!value || value.kind !== WORKSPACE_EDIT_KIND) fail('Workspace edit recovery record is unavailable');
    return value;
  };
  const executionOf = (value: Record<string, unknown>): Execution => {
    const stored = (value.result ?? value.data) as { workspaceEdit?: Execution };
    if (!stored?.workspaceEdit?.plan || !stored.workspaceEdit.receipt || !Array.isArray(stored.workspaceEdit.actions))
      fail('Workspace edit recovery record is malformed');
    return clone(stored.workspaceEdit);
  };
  const save = async (context: DurableFileOperationContext, execution: Execution, state = 'applying') => {
    execution.receipt.resourceResults = execution.receipt.affectedResources.map((resource) => {
      const states = execution.plan.actions.flatMap((action, index) =>
        (action.kind === 'disk'
          ? Object.keys(action.after)
          : action.after.map((slot) => slot.resource.resourceId)
        ).includes(resource.resourceId)
          ? [execution.actions[index]]
          : []
      );
      return {
        resource,
        status: states.includes('needs-attention')
          ? 'needs-attention'
          : states.includes('dispatched')
            ? 'pending'
            : states.includes('applied')
              ? 'applied'
              : states.includes('restored')
                ? 'restored'
                : 'unchanged',
      };
    });
    const current = await operation(context, execution.plan.operationId);
    await context.durableRecoveryStore.completeOperation({
      workspaceId: execution.plan.workspaceId,
      operationId: execution.plan.operationId,
      expectedRevision: Number(current.revision),
      state,
      result: { workspaceEdit: execution },
    });
  };
  const mark = async (context: DurableFileOperationContext, execution: Execution, paths: string[], phase: string) => {
    const current = await operation(context, execution.plan.operationId);
    const files = current.files as Array<{ path: string; revision: number; phase: string }>;
    for (const path of paths) {
      const file = files.find((file) => file.path === path);
      if (!file) fail(`Workspace edit recovery path is missing: ${path}`);
      await context.durableRecoveryStore.updateOperationFile({
        workspaceId: execution.plan.workspaceId,
        operationId: execution.plan.operationId,
        path,
        expectedRevision: file.revision,
        expectedPhase: file.phase,
        phase,
      });
    }
  };
  const receipt = (plan: Plan): VarinWorkspaceEditReceipt => ({
    operationId: plan.operationId,
    workspaceId: plan.workspaceId,
    status: 'pending',
    appliedSteps: [],
    restoredSteps: [],
    affectedResources: [
      ...new Set(
        plan.actions.flatMap((action) =>
          action.kind === 'disk' ? Object.keys(action.after) : action.after.map((slot) => slot.resource.resourceId)
        )
      ),
    ].map((path) => resource(plan.workspaceId, path)),
    failures: [],
  });
  const publicReceipt = (stored: Record<string, unknown>): VarinWorkspaceEditReceipt => {
    const result = executionOf(stored).receipt;
    const statuses: Record<string, VarinWorkspaceEditReceipt['status']> = {
      complete: 'applied',
      compensated: 'compensated',
      undone: 'undone',
      'needs-attention': 'needs-attention',
      aborted: 'rejected',
    };
    return { ...result, status: statuses[String(stored.state)] ?? 'pending' };
  };
  const read = async (request: {
    workspaceId: string;
    operationId: string;
  }): Promise<VarinWorkspaceEditReceipt | { status: 'missing' }> =>
    services.storage(request.workspaceId, async (context) => {
      const stored = await context.durableRecoveryStore.getOperation(request.workspaceId, request.operationId);
      if (!stored || stored.kind !== WORKSPACE_EDIT_KIND) return { status: 'missing' };
      return publicReceipt(stored);
    });
  const surface = async (
    execution: Execution,
    action: BufferAction,
    barrierId: string,
    stepId: string,
    mode: 'validate' | 'apply',
    reversed = false
  ) => {
    const before = clone(reversed ? action.after : action.before);
    const after = clone(reversed ? action.before : action.after);
    if (reversed) {
      for (const slot of before)
        if (slot.buffer)
          slot.buffer.localEditRevision =
            execution.bufferVersions?.[bufferVersionKey(action.owner, slot.buffer.documentInstanceId)] ??
            slot.buffer.localEditRevision;
      for (const slot of after)
        if (slot.buffer)
          slot.buffer.localEditRevision =
            (execution.bufferVersions?.[bufferVersionKey(action.owner, slot.buffer.documentInstanceId)] ??
              slot.buffer.localEditRevision) + 1;
    }
    await services.surface(execution.plan.workspaceId, action.owner, barrierId, execution.plan.operationId, {
      stepId,
      mode,
      origin: reversed ? `workspace-edit-undo:${execution.plan.operationId}` : execution.plan.origin,
      epoch: execution.plan.epoch,
      before,
      after,
    });
    if (mode === 'apply')
      for (const slot of after)
        if (slot.buffer)
          (execution.bufferVersions ??= {})[bufferVersionKey(action.owner, slot.buffer.documentInstanceId)] =
            slot.buffer.localEditRevision;
  };
  const applyDisk = async (context: DurableFileOperationContext, action: DiskAction, id: string, reversed = false) => {
    const expected = reversed ? action.after : action.before;
    const target = reversed ? action.before : action.after;
    await verify(
      context,
      expected,
      Object.entries(expected)
        .filter(([, state]) => state.kind === 'directory')
        .map(([resourceId]) => ({ resourceId, scope: 'subtree' }))
    );
    const files = requireFiles(context);
    if (action.rename) {
      const from = reversed ? action.rename.to : action.rename.from;
      const to = reversed ? action.rename.from : action.rename.to;
      const result = await files.rename(context.identity, from, to, {
        expectedFrom: expected[from]!,
        expectedTo: expected[to]!,
        targetMustBeMissing: !action.rename.sameLocation,
        operationId: id,
      });
      if (result !== 'renamed') fail(`Rename conflicted: ${from} → ${to}`);
    } else {
      for (const [path, state] of Object.entries(target)) {
        // The immutable empty body is already retained before the first resource write.
        const result =
          state.kind === 'regular-file' &&
          state.byteLength === 0 &&
          state.objectHash === (emptyFile as Extract<RecoveryState, { kind: 'regular-file' }>).objectHash
            ? await files.writeBytes(context.identity, path, new Uint8Array(), {
                expected: expected[path]!,
                operationId: id,
                ...(state.mode === undefined ? {} : { mode: state.mode }),
              })
            : await files.applyStateDetailed(context.identity, path, state, {
                expected: expected[path]!,
                operationId: id,
              });
        if (result.status !== 'applied') fail(`Resource changed during workspace edit: ${path}`);
      }
    }
    await verify(context, target);
  };
  const classifyDisk = async (
    context: DurableFileOperationContext,
    action: DiskAction
  ): Promise<'applied' | 'not-applied' | 'needs-attention'> => {
    try {
      await verify(context, action.after);
      return 'applied';
    } catch {
      /* An observed mismatch is not proof of no effect. */
    }
    try {
      await verify(context, action.before);
      return 'not-applied';
    } catch {
      return 'needs-attention';
    }
  };
  const compensate = async (
    context: DurableFileOperationContext,
    execution: Execution,
    barrierId: string,
    undo: boolean
  ) => {
    const blocked = new Set<string>();
    for (let index = execution.plan.actions.length - 1; index >= 0; index--) {
      const action = execution.plan.actions[index]!;
      const affected =
        action.kind === 'disk' ? Object.keys(action.after) : action.after.map((slot) => slot.resource.resourceId);
      if (
        affected.some((path) =>
          [...blocked].some((blockedPath) => contains(path, blockedPath) || contains(blockedPath, path))
        ) &&
        ['applied', 'dispatched'].includes(execution.actions[index]!)
      )
        execution.actions[index] = 'needs-attention';
      if (execution.actions[index] === 'needs-attention') {
        for (const path of affected) blocked.add(path);
        continue;
      }
      if (execution.actions[index] === 'dispatched' && action.kind === 'disk')
        execution.actions[index] = await classifyDisk(context, action);
      if (execution.actions[index] === 'dispatched') execution.actions[index] = 'needs-attention';
      if (execution.actions[index] === 'needs-attention') for (const path of affected) blocked.add(path);
      if (execution.actions[index] !== 'applied') continue;
      try {
        const paths =
          action.kind === 'disk' ? Object.keys(action.after) : action.after.map((slot) => slot.resource.resourceId);
        await mark(
          context,
          execution,
          paths,
          action.kind === 'disk' ? 'compensate-intent' : 'external-compensate-intent'
        );
        await save(context, execution, 'undoing');
        if (barrierId) services.assertBarrier(barrierId);
        if (action.kind === 'disk') {
          await applyDisk(context, action, `${action.id}:undo`, true);
          services.notify(execution.plan.workspaceId, action, true, execution.plan.operationId);
        } else await surface(execution, action, barrierId, `${action.id}:undo`, 'apply', true);
        execution.actions[index] = 'restored';
        await mark(context, execution, paths, action.kind === 'disk' ? 'safety-observed' : 'external-safety-observed');
        if (!execution.receipt.restoredSteps.includes(action.step)) execution.receipt.restoredSteps.push(action.step);
      } catch (error) {
        execution.actions[index] = 'needs-attention';
        for (const path of affected) blocked.add(path);
        execution.receipt.failures.push({
          step: action.step,
          reason: 'recovery-conflict',
          message: errorText(error),
          resource:
            action.kind === 'disk'
              ? resource(execution.plan.workspaceId, Object.keys(action.after)[0]!)
              : action.after[0]!.resource,
        });
      }
      await save(context, execution, 'undoing');
    }
    const attentionPaths = [
      ...new Set(
        execution.plan.actions.flatMap((action, index) =>
          execution.actions[index] === 'needs-attention'
            ? action.kind === 'disk'
              ? Object.keys(action.after)
              : action.after.map((slot) => slot.resource.resourceId)
            : []
        )
      ),
    ];
    if (attentionPaths.length) await mark(context, execution, attentionPaths, 'needs-attention');
    execution.receipt.status = execution.actions.includes('needs-attention')
      ? 'needs-attention'
      : undo
        ? 'undone'
        : 'compensated';
    await save(
      context,
      execution,
      execution.receipt.status === 'needs-attention' ? 'needs-attention' : undo ? 'undone' : 'compensated'
    );
  };
  const withBarrier = async <T>(plan: Plan, callback: (barrierId: string) => Promise<T>): Promise<T> => {
    // Quiesce saves before taking file leases; a save may already own the same lease.
    const barrier = await services.barrier(plan.workspaceId, Object.keys(plan.initialDisk));
    try {
      await barrier.settle();
      return await callback(barrier.barrierId);
    } finally {
      await barrier.release();
    }
  };
  const execute = async (request: { workspaceId: string; operationId: string }): Promise<VarinWorkspaceEditReceipt> => {
    const recorded = await read(request);
    if (recorded.status !== 'missing') return recorded;
    const plan = plans.get(key(request.workspaceId, request.operationId));
    if (!plan)
      return {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        status: 'rejected',
        appliedSteps: [],
        restoredSteps: [],
        affectedResources: [],
        failures: [{ reason: 'stale-plan', message: 'Workspace edit preview is no longer available' }],
      };
    const execution: Execution = { plan, receipt: receipt(plan), actions: plan.actions.map(() => 'pending') };
    try {
      return await withBarrier(plan, (barrierId) =>
        services.storage(request.workspaceId, (context) =>
          services.resources(plan.workspaceId, plan.scopes, () =>
            services.mutate(plan.workspaceId, plan.epoch, plan.operationId, async () => {
              const current = await services.inspect(request.workspaceId);
              if (current.root !== plan.root || current.epoch !== plan.epoch || services.hostId !== plan.hostId)
                fail('Workspace identity changed after preparation');
              for (const [path, identity] of Object.entries(plan.resourceIdentities))
                if ((await services.resolve(resource(plan.workspaceId, path))).coordinationId !== identity)
                  fail(`Resource identity changed after preparation: ${path}`);
              await verify(context, plan.initialDisk, plan.scopes);
              await services.validateDirtyOwners(plan.workspaceId, Object.keys(plan.initialDisk), plan.surfaces);
              for (const [index, baseline] of plan.surfaces.entries()) {
                const currentOwner = services.owner(
                  plan.workspaceId,
                  baseline.owner.ownerId,
                  baseline.owner.generation
                );
                if (currentOwner.registrationId !== baseline.owner.registrationId)
                  fail('Document surface reconnected after preparation');
                await surface(
                  execution,
                  { kind: 'buffer', owner: baseline.owner, before: baseline.buffers, after: baseline.buffers },
                  barrierId,
                  `${plan.operationId}:validate:${index}`,
                  'validate'
                );
              }
              // Recovery takes ownership of original disk bytes before any effect. Preparation never does this.
              await capture(context, Object.keys(plan.initialDisk), true);
              await verify(context, plan.initialDisk, plan.scopes);
              if (!context.fileStore.storeContent)
                throw new Error('Workspace edit recovery content owner is unavailable');
              const empty = await context.fileStore.storeContent(context.identity, Buffer.alloc(0));
              try {
                const targets = Object.fromEntries(
                  Object.entries(plan.initialDisk).map(([path, state]) => [
                    path,
                    { expected: state, safety: state, target: plan.finalDisk[path] ?? missing },
                  ])
                );
                await context.durableRecoveryStore.createOperation({
                  operationId: plan.operationId,
                  workspaceId: plan.workspaceId,
                  kind: WORKSPACE_EDIT_KIND,
                  state: 'applying',
                  data: { workspaceEdit: execution },
                  targets,
                });
                // The original identity wins if a concurrent request already admitted this operation.
                const stored = executionOf(await operation(context, plan.operationId));
                if (!isDeepStrictEqual(stored.plan, plan)) fail('Workspace edit operation identity was already used');
                for (const [index, action] of plan.actions.entries()) {
                  services.assertBarrier(barrierId);
                  const paths =
                    action.kind === 'disk'
                      ? Object.keys(action.after)
                      : action.after.map((slot) => slot.resource.resourceId);
                  execution.actions[index] = 'dispatched';
                  await save(context, execution);
                  await mark(
                    context,
                    execution,
                    paths,
                    action.kind === 'disk' ? 'apply-intent' : 'external-dispatched'
                  );
                  try {
                    if (action.kind === 'disk') {
                      await applyDisk(context, action, action.id);
                      services.notify(plan.workspaceId, action, false, plan.operationId);
                    } else await surface(execution, action, barrierId, action.id, 'apply');
                  } catch (error) {
                    if (error instanceof WorkspaceEditSurfaceRejectedError) execution.actions[index] = 'not-applied';
                    if (error instanceof WorkspaceEditSurfaceAppliedError) {
                      execution.actions[index] = 'applied';
                      if (action.kind === 'buffer')
                        for (const slot of action.after)
                          if (slot.buffer)
                            (execution.bufferVersions ??= {})[
                              bufferVersionKey(action.owner, slot.buffer.documentInstanceId)
                            ] = slot.buffer.localEditRevision;
                    }
                    throw error;
                  }
                  execution.actions[index] = 'applied';
                  if (!execution.receipt.appliedSteps.includes(action.step))
                    execution.receipt.appliedSteps.push(action.step);
                  await mark(
                    context,
                    execution,
                    paths,
                    action.kind === 'disk' ? 'target-observed' : 'external-target-observed'
                  );
                  await save(context, execution);
                }
                execution.receipt.status = 'applied';
                await save(context, execution, 'complete');
                return clone(execution.receipt);
              } catch (error) {
                // A lost completion response is resolved by its original durable record.
                const latest = await read(request);
                if (latest.status === 'applied') return latest;
                execution.receipt.failures.push({ reason: 'apply-failed', message: errorText(error) });
                await compensate(context, execution, barrierId, false);
                return clone(execution.receipt);
              } finally {
                await empty?.release();
              }
            })
          )
        )
      );
    } catch (error) {
      const recorded = await read(request);
      if (recorded.status !== 'missing') return recorded;
      execution.receipt.status = 'rejected';
      execution.receipt.failures.push({ reason: 'stale-plan', message: errorText(error) });
      return execution.receipt;
    } finally {
      plans.delete(key(request.workspaceId, request.operationId));
    }
  };
  const serialized = (
    request: { workspaceId: string; operationId: string },
    run: () => Promise<VarinWorkspaceEditReceipt>
  ) => {
    if (disposed)
      return Promise.reject(
        new DocumentAuthorityError('Document authority is disposed', { code: 'failed', statusCode: 503 })
      );
    const id = key(request.workspaceId, request.operationId);
    const existing = active.get(id);
    if (existing) return existing;
    const result = run();
    active.set(id, result);
    void result
      .finally(() => {
        if (active.get(id) === result) active.delete(id);
      })
      .catch(() => undefined);
    return result;
  };
  const undo = (request: { workspaceId: string; operationId: string }): Promise<VarinWorkspaceEditReceipt> =>
    serialized(request, async () =>
      services.storage(request.workspaceId, async (context) => {
        const execution = executionOf(await operation(context, request.operationId));
        if (execution.receipt.status === 'undone' || execution.receipt.status === 'compensated')
          return execution.receipt;
        if (!['applied', 'needs-attention'].includes(execution.receipt.status)) return execution.receipt;
        return withBarrier(execution.plan, (barrierId) =>
          services.resources(execution.plan.workspaceId, execution.plan.scopes, () =>
            services.mutate(
              execution.plan.workspaceId,
              execution.plan.epoch,
              `${execution.plan.operationId}:undo`,
              async () => {
                const current = await services.inspect(execution.plan.workspaceId);
                if (
                  current.root !== execution.plan.root ||
                  current.epoch !== execution.plan.epoch ||
                  services.hostId !== execution.plan.hostId
                )
                  fail('Workspace identity changed before undo');
                await compensate(context, execution, barrierId, true);
                return execution.receipt;
              }
            )
          )
        );
      })
    );
  const reconcile = async (workspaceId: string): Promise<VarinWorkspaceEditReceipt[]> =>
    services.storage(workspaceId, async (context) => {
      const results: VarinWorkspaceEditReceipt[] = [];
      for (const summary of await context.durableRecoveryStore.listOperations(workspaceId, WORKSPACE_EDIT_KIND)) {
        if (
          active.has(key(workspaceId, String(summary.operationId))) ||
          ['complete', 'compensated', 'undone', 'aborted'].includes(String(summary.state))
        )
          continue;
        const execution = executionOf(await operation(context, String(summary.operationId)));
        // A fresh Host cannot manufacture a former Registry receipt. Disk recovery is still conditional.
        await services.resources(execution.plan.workspaceId, execution.plan.scopes, () =>
          services.mutate(
            execution.plan.workspaceId,
            execution.plan.epoch,
            `${execution.plan.operationId}:reconcile`,
            async () => {
              const current = await services.inspect(execution.plan.workspaceId);
              if (
                current.root !== execution.plan.root ||
                current.epoch !== execution.plan.epoch ||
                services.hostId !== execution.plan.hostId
              )
                fail('Workspace identity changed before recovery');
              await compensate(context, execution, '', false);
              results.push(clone(execution.receipt));
            }
          )
        );
      }
      return results;
    });
  const recovery = (request: { workspaceId: string; operationId: string }) =>
    services.storage(request.workspaceId, async (context) => {
      const execution = executionOf(await operation(context, request.operationId));
      return {
        receipt: publicReceipt(await operation(context, request.operationId)),
        buffers: execution.plan.initialBuffers.flatMap((slot) =>
          slot.buffer && hasDraft(slot.buffer) ? [slot.buffer] : []
        ),
      };
    });
  return {
    prepare,
    read,
    recovery,
    apply: (request: { workspaceId: string; operationId: string }) => serialized(request, () => execute(request)),
    undo,
    reconcile,
    list: (workspaceId: string) =>
      services.storage(workspaceId, async (context) =>
        Promise.all(
          (await context.durableRecoveryStore.listOperations(workspaceId, WORKSPACE_EDIT_KIND)).map(async (value) =>
            publicReceipt(await operation(context, String(value.operationId)))
          )
        )
      ),
    discard(request: { workspaceId: string; operationId: string }) {
      return { discarded: plans.delete(key(request.workspaceId, request.operationId)) };
    },
    dispose() {
      disposed = true;
      plans.clear();
      return Promise.allSettled([...active.values()]).then(() => undefined);
    },
  };
};

/** An authenticated negative receipt proves that this specific buffer dispatch did not apply. */
export class WorkspaceEditSurfaceRejectedError extends Error {}

/** Buffer effect is confirmed, but its recovery journal migration failed. */
export class WorkspaceEditSurfaceAppliedError extends Error {}
