import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectEntry, ThreadSource, VersionedProjectWorkspace } from '@varin/application-client';
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from './kernel-client.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelWorkspaceInspection, LaunchSource, ChildSourceProvenance, KernelBranchChange } from './protocol.generated.js';
import { withAncestorDirectories } from '../harness/working-state/workspace-baseline.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { nativeGitRoots } from './native-git-roots.js';
export class WorkspaceBackendUnavailableError extends Error {
    readonly code = 'workspace_backend_unavailable';
}
export async function requireNativeWorkspaceBackend(actor: Pick<KernelScopedClient, 'inspectWorkspaceBackend'>, signal?: AbortSignal): Promise<void> {
    const backend = await actor.inspectWorkspaceBackend(signal);
    if (!backend.dependenciesReady) throw new WorkspaceBackendUnavailableError(
        `${backend.detail ?? 'Native workspace backend is unavailable'} (${backend.helpUrl})`);
}
export function nativeExecutionWorkspaceId(execution: string): string {
    const bytes = createHash('sha256').update(`native-execution\0${execution}`).digest();
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type Source = Pick<LaunchSource, 'workspace_id' | 'execution_workspace_id' | 'branch_id' | 'native_scope'>;
export interface NativeDocumentWorkspace {
    workspaceId: string;
    originalPath: string;
    root: string;
    hostId: string;
    reference: Source;
}
interface Owners {
    kernel: KernelClient;
    documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration' | 'canReleaseNativeSource' | 'forgetNativeSource'>;
    projects(): Promise<readonly ProjectEntry[]>;
    update(projectId: string, value: VersionedProjectWorkspace): Promise<void>;
}
interface Opened {
    epoch: string;
    grant: KernelGrantHandle;
    view: KernelWorkspaceInspection;
    source: Source;
    originalPath: string;
}
interface Flight<T> {
    work: Promise<T>;
    controller: AbortController;
    observers: number;
}
interface SnapshotOptions {
    threadId?: string;
    selection?: Extract<ChildSourceProvenance, {
        consistency: 'fixed-root';
    }>['selection'];
    editorDrafts?: readonly {
        path: string;
        content: Buffer;
    }[];
    resources?: import('./protocol.generated.js').SourceResourceCapture;
    beforePublish?(actor: KernelScopedClient, branchId: string): Promise<void>;
}
function observe<T>(flight: Flight<T>, signal?: AbortSignal): Promise<T> {
    flight.observers++;
    return new Promise((resolve, reject) => {
        let active = true;
        const leave = () => {
            if (!active)
                return false;
            active = false;
            flight.observers--;
            signal?.removeEventListener('abort', abort);
            return true;
        };
        const abort = () => {
            if (!leave())
                return;
            const reason = signal?.reason ?? new DOMException('Workspace preparation cancelled', 'AbortError');
            if (flight.observers) {
                reject(reason);
                return;
            }
            flight.controller.abort(reason);
            void flight.work.then(() => reject(reason), () => reject(reason));
        };
        void flight.work.then(value => {
            if (leave())
                resolve(value);
        }, error => {
            if (leave())
                reject(error);
        });
        if (signal?.aborted)
            abort();
        else
            signal?.addEventListener('abort', abort, { once: true });
    });
}
/** Host adapter only. Rust owns every byte, version, mount and execution lease. */
export function createNativeWorkspaceOwner(owners: Owners) {
    const opened = new Map<string, Opened>();
    const opening = new Map<string, Flight<Opened>>();
    const enabling = new Map<string, Flight<Awaited<ReturnType<typeof enableProject>>>>();
    const known = new Map<string, Source>();
    const documentViews = new Map<string, Source>();
    const retiring = new Set<string>();
    const references = new Map<string, Promise<{
        epoch: string;
        grant: KernelGrantHandle;
        source: Source;
    }>>();
    const documentId = (source: Source) => {
        if (!source.native_scope)
            return source.execution_workspace_id;
        const bytes = createHash('sha256').update(JSON.stringify(['native-document', source.execution_workspace_id, source.native_scope])).digest();
        bytes[6] = (bytes[6]! & 15) | 64;
        bytes[8] = (bytes[8]! & 63) | 128;
        const hex = bytes.subarray(0, 16).toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const sourceOf = (workspace: VersionedProjectWorkspace): Source => ({ workspace_id: workspace.workspaceId,
        execution_workspace_id: workspace.executionWorkspaceId, branch_id: workspace.branchId });
    const open = async (source: Source, signal?: AbortSignal): Promise<Opened> => {
        if (!source.branch_id)
            throw new Error('Native workspace branch is missing');
        if (retiring.has(source.branch_id))
            throw new Error('source_retiring: the original source is being released');
        const registration = await owners.documents.admitWorkspaceRegistration(source.workspace_id, signal);
        const handshake = owners.kernel.handshake ?? await owners.kernel.start();
        const branch = source.branch_id;
        const inflight = opening.get(branch);
        if (inflight) {
            if (inflight.controller.signal.aborted) {
                await inflight.work.catch(() => undefined);
                return open(source, signal);
            }
            const entry = await observe(inflight, signal);
            if (entry.source.workspace_id !== source.workspace_id || entry.source.execution_workspace_id !== source.execution_workspace_id)
                throw new Error('Native workspace source identity changed');
            return entry;
        }
        const prior = opened.get(branch);
        if (prior?.epoch === handshake.kernelEpoch) {
            if (prior.source.workspace_id !== source.workspace_id || prior.source.execution_workspace_id !== source.execution_workspace_id)
                throw new Error('Native workspace source identity changed');
            if (prior.view.mount?.state === 'ready')
                return prior;
        }
        const controller = new AbortController(), ownerSignal = controller.signal;
        const work = (async () => {
            if (prior?.epoch === handshake.kernelEpoch) {
                await owners.kernel.scoped(prior.grant).closeWorkspace({ branchId: branch, generation: prior.view.binding.generation });
                await owners.kernel.revokeGrant(prior.grant.grantId);
                opened.delete(branch);
            }
            const grant = await owners.kernel.issueGrant({ grantId: `native-project:${randomUUID()}`, owningWorkspace: source.workspace_id,
                executionWorkspace: source.execution_workspace_id, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }, ownerSignal);
            const actor = owners.kernel.scoped(grant);
            let view: KernelWorkspaceInspection;
            try {
                view = await actor.openWorkspace({ branchId: branch }, ownerSignal);
            }
            catch (error) {
                await owners.kernel.revokeGrant(grant.grantId);
                throw error;
            }
            // Retain a failed mount's original owner as well: close/retry must service
            // the same callbacks and cleanup responsibility, never substitute a copy.
            const entry: Opened = { epoch: handshake.kernelEpoch, grant, view, source: { workspace_id: source.workspace_id, execution_workspace_id: source.execution_workspace_id, branch_id: source.branch_id }, originalPath: registration.canonicalPath };
            opened.set(branch, entry);
            known.set(source.execution_workspace_id, { ...entry.source });
            entry.view = await actor.mountWorkspace({ branchId: branch, generation: view.binding.generation }, ownerSignal);
            if (entry.view.mount?.state !== 'ready' || !entry.view.mount.path || !entry.view.rootId)
                throw new Error('Native workspace mount is unavailable');
            return entry;
        })().finally(() => opening.delete(branch));
        const flight = { work, controller, observers: 0 };
        opening.set(branch, flight);
        return observe(flight, signal);
    };
    const projectFor = async (workspaceId: string) => {
        const projects = await owners.projects();
        return projects.find(project => project.versionedWorkspace?.state === 'ready' &&
            [project.versionedWorkspace.workspaceId, project.versionedWorkspace.executionWorkspaceId].includes(workspaceId));
    };
    const prepare = async (workspaceId: string, signal?: AbortSignal): Promise<{
        source: ThreadSource;
        path: string;
    } | undefined> => {
        let project = await projectFor(workspaceId);
        // Resolve the registered project only at execution preparation. Browsing a
        // directory does not import it, and a child/subdirectory keeps its own source.
        if (!project && !documentViews.has(workspaceId) && !known.has(workspaceId)) {
            const registration = await owners.documents.admitWorkspaceRegistration(workspaceId, signal);
            project = (await owners.projects()).find(candidate =>
                normalizePathIdentity(candidate.path) === normalizePathIdentity(registration.canonicalPath));
            if (project) {
                const prepared = await enable(project.id, signal);
                project = { ...project, versionedWorkspace: prepared.workspace };
            }
        }
        const ref = project?.versionedWorkspace;
        const selected = ref ? sourceOf(ref) : documentViews.get(workspaceId) ?? known.get(workspaceId);
        if (!selected)
            return undefined;
        const entry = await open(selected, signal);
        const actual = await acquire(selected, entry.grant, signal);
        return { path: actual.path, source: { resourceOwner: { kind: 'local' }, workspaceId: selected.workspace_id,
                executionWorkspaceId: selected.execution_workspace_id, mode: 'native_workspace', branchId: selected.branch_id!, ...(selected.native_scope ? { nativeScope: selected.native_scope } : {}), tools: [] } };
    };
    const acquire = async (source: Source, grant: KernelGrantHandle, signal?: AbortSignal) => {
        const entry = await open(source, signal);
        const address = { branchId: source.branch_id!, generation: entry.view.binding.generation, ...(source.native_scope ? { sourcePath: source.native_scope } : {}) };
        let view: KernelWorkspaceInspection;
        try {
            view = await owners.kernel.scoped(grant).bindWorkspace(address, signal);
        }
        catch (error) {
            entry.view = await owners.kernel.scoped(entry.grant).inspectWorkspace({ branchId: source.branch_id!, generation: entry.view.binding.generation }).catch(() => entry.view);
            throw error;
        }
        if (view.mount?.state !== 'ready' || !view.mount.path || !view.rootId) {
            entry.view = { ...entry.view, mount: view.mount };
            throw new Error('The original native source mount is unavailable');
        }
        documentViews.set(documentId(source), { ...source });
        return { address, rootId: view.rootId, path: view.mount.path, hostId: owners.kernel.handshake!.hostId };
    };
    const resolveId = async (workspaceId: string, signal?: AbortSignal, reference?: Source): Promise<NativeDocumentWorkspace | undefined> => {
        if (reference)
            documentViews.set(workspaceId, { ...reference });
        let source = documentViews.get(workspaceId) ?? known.get(workspaceId);
        if (!source) {
            const project = await projectFor(workspaceId);
            if (project?.versionedWorkspace?.executionWorkspaceId === workspaceId)
                source = sourceOf(project.versionedWorkspace);
        }
        if (!source)
            return undefined;
        const entry = await open(source, signal);
        const physical = await acquire(source, entry.grant, signal);
        return { workspaceId, originalPath: entry.originalPath, root: physical.path, hostId: physical.hostId, reference: { ...source } };
    };
    const resolvePath = async (value: string, containing = false): Promise<NativeDocumentWorkspace | undefined> => {
        const selected = normalizePathIdentity(path.resolve(value)).replace(/\\/g, '/');
        for (const entry of opened.values()) {
            if (entry.epoch !== owners.kernel.handshake?.kernelEpoch || entry.view.mount?.state !== 'ready' || !entry.view.mount.path)
                continue;
            const root = normalizePathIdentity(entry.view.mount.path).replace(/\\/g, '/');
            if (selected !== root && !selected.startsWith(`${root}/`))
                continue;
            const scope = containing ? '' : selected.slice(root.length).replace(/^\//, '');
            const source = { ...entry.source, ...(scope ? { native_scope: scope } : {}) };
            const id = documentId(source);
            documentViews.set(id, source);
            return resolveId(id);
        }
        return undefined;
    };
    const enableProject = async (projectId: string, signal?: AbortSignal) => {
        const project = (await owners.projects()).find(project => project.id === projectId);
        if (!project)
            throw new Error('Project is unavailable');
        let ref = project.versionedWorkspace;
        if (!ref) {
            const registered = await owners.documents.resolveWorkspace({ path: project.path });
            ref = { workspaceId: registered.workspaceId, executionWorkspaceId: randomUUID(), branchId: `project-workspace:${randomUUID()}`,
                adoptionOperationId: `workspace-adopt:${randomUUID()}`, state: 'preparing' };
            await owners.update(projectId, ref);
        }
        const registration = await owners.documents.admitWorkspaceRegistration(ref.workspaceId, signal);
        // The source path is the admitted original registration, never loadWorkspace's
        // execution view. Restart resumes this exact adoption operation.
        const grant = await owners.kernel.issueGrant({ grantId: `workspace-adoption:${randomUUID()}`, owningWorkspace: ref.workspaceId,
            executionWorkspace: ref.executionWorkspaceId, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }, signal);
        try {
            const actor = owners.kernel.scoped(grant);
            const adopted = await actor.getOperation(ref.adoptionOperationId, signal);
            await requireNativeWorkspaceBackend(actor, signal);
            if (adopted?.state !== 'committed') {
                const root = await actor.fileRootRegister({ workspaceId: ref.workspaceId, executionWorkspaceId: ref.executionWorkspaceId, canonicalRoot: registration.canonicalPath }, signal);
                const gitRoots = await nativeGitRoots(registration.canonicalPath, owners.documents, signal);
                const gitRootIds = [];
                for (const canonicalRoot of gitRoots) {
                    const registered = await actor.fileRootRegister({ workspaceId: ref.workspaceId, executionWorkspaceId: ref.executionWorkspaceId, canonicalRoot }, signal);
                    gitRootIds.push(registered.rootId);
                }
                await actor.adoptWorkspace({ branchId: ref.branchId, rootId: root.rootId, operationId: ref.adoptionOperationId, ...(gitRootIds.length ? { gitRootIds } : {}) }, signal);
            }
            const entry = await open(sourceOf(ref), signal);
            const ready = { ...ref, state: 'ready' as const };
            await owners.update(projectId, ready);
            return { workspace: ready, view: entry.view };
        }
        finally {
            await owners.kernel.revokeGrant(grant.grantId);
        }
    };
    const enable = async (projectId: string, signal?: AbortSignal) => {
        let flight = enabling.get(projectId);
        if (flight?.controller.signal.aborted) {
            await flight.work.catch(() => undefined);
            flight = undefined;
        }
        if (!flight) {
            const controller = new AbortController();
            const work = enableProject(projectId, controller.signal).finally(() => enabling.delete(projectId));
            flight = { controller, work, observers: 0 };
            enabling.set(projectId, flight);
        }
        return observe(flight, signal);
    };
    const disable = async (projectId: string) => {
        const preparation = enabling.get(projectId);
        if (preparation) {
            preparation.controller.abort();
            await preparation.work.catch(() => undefined);
        }
        const project = (await owners.projects()).find(project => project.id === projectId), ref = project?.versionedWorkspace;
        if (!ref)
            throw new Error('Project has no versioned workspace');
        const entry = opened.get(ref.branchId);
        if (entry && entry.epoch === owners.kernel.handshake?.kernelEpoch) {
            try {
                await owners.kernel.scoped(entry.grant).closeWorkspace({ branchId: ref.branchId, generation: entry.view.binding.generation });
            }
            catch (error) {
                entry.view = await owners.kernel.scoped(entry.grant).inspectWorkspace({ branchId: ref.branchId, generation: entry.view.binding.generation }).catch(() => entry.view);
                throw error;
            }
            await owners.kernel.revokeGrant(entry.grant.grantId);
            opened.delete(ref.branchId);
        }
        known.delete(ref.executionWorkspaceId);
        await owners.update(projectId, { ...ref, state: 'disabled' });
    };
    const inspectProject = async (projectId: string, signal?: AbortSignal) => {
        const project = (await owners.projects()).find(project => project.id === projectId);
        if (!project)
            throw new Error('Project is unavailable');
        const ref = project.versionedWorkspace;
        if (!ref || ref.state !== 'ready') {
            let progress: {
                phase: string;
                entries: number;
                bytes: number;
            } | null = null;
            if (ref?.state === 'preparing') {
                await owners.documents.admitWorkspaceRegistration(ref.workspaceId, signal);
                const grant = await owners.kernel.issueGrant({ grantId: `workspace-progress:${randomUUID()}`, owningWorkspace: ref.workspaceId,
                    executionWorkspace: ref.executionWorkspaceId, capabilities: ['storage.read'], pathScopes: [''] }, signal);
                try {
                    const operation = await owners.kernel.scoped(grant).getOperation(ref.adoptionOperationId, signal);
                    const result = operation?.result as Record<string, unknown> | undefined;
                    if (operation?.state === 'started' && result)
                        progress = { phase: String(result.phase ?? 'inventory'), entries: Number(result.entries ?? 0), bytes: Number(result.bytes ?? 0) };
                }
                finally {
                    await owners.kernel.revokeGrant(grant.grantId);
                }
            }
            return { workspace: ref ?? null, view: null, progress, preparing: enabling.has(projectId) };
        }
        const entry = await open(sourceOf(ref), signal);
        entry.view = await owners.kernel.scoped(entry.grant).inspectWorkspace({ branchId: ref.branchId, generation: entry.view.binding.generation }, signal);
        return { workspace: ref, view: entry.view, progress: null, preparing: false };
    };
    const retainPrepared = async (source: Source, threadId: string, release = false, signal?: AbortSignal) => {
        if (!source.branch_id)
            throw new Error('Prepared source branch is missing');
        await owners.kernel.agentRuntimeRequest('runtime.source.preparation', { threadId, source: { workspace_id: source.workspace_id, execution_workspace_id: nativeExecutionWorkspaceId(source.branch_id), branch_id: source.branch_id, resource_owner: { kind: 'local' }, mode: 'native_workspace', revision: null, live_root: null }, release }, signal);
    };
    const snapshot = async (source: Source, targetBranchId: string, operationId: string, signal?: AbortSignal, selectionIdentity?: string, options: SnapshotOptions = {}) => {
        const entry = await open(source, signal), actor = owners.kernel.scoped(entry.grant);
        const parentRef = `native-source:${JSON.stringify([source.branch_id, source.native_scope ?? '', selectionIdentity ?? operationId])}`;
        const temporary = `native-snapshot:${operationId}`;
        const retainPreparation = async (branchId: string, release = false) => {
            if (options.threadId)
                await retainPrepared({ ...source, branch_id: branchId }, options.threadId, release, signal);
        };
        await retainPreparation(targetBranchId);
        await retainPreparation(temporary);
        const completed = await actor.getOperation(`branch-fork:${targetBranchId}`, signal);
        if (completed) {
            const result = completed.result as {
                branchId?: string;
                workspaceId?: string;
                root?: string;
            };
            const original = await actor.readBranch({ branchId: targetBranchId, revision: 0, includeEntries: false }, signal);
            if (!['branch.create', 'branch.fork'].includes(String(completed.kind)) || completed.state !== 'committed' || result.branchId !== targetBranchId
                || result.workspaceId !== source.workspace_id || original.parentRef !== parentRef || original.root !== result.root)
                throw new Error('Workspace snapshot selection changed');
            await actor.deleteBranch({ operationId: `snapshot-cleanup:${operationId}`, branchId: temporary }, signal);
            await retainPreparation(temporary, true);
            return;
        }
        const previous = await actor.getOperation(operationId, signal);
        if (previous) {
            const result = previous.result as {
                filesystem?: {
                    sourceBranchId?: string;
                    targetBranchId?: string;
                    sourcePath?: string;
                };
            };
            if (previous.kind !== 'workspace.checkpoint.fork' || previous.state !== 'committed' || result.filesystem?.sourceBranchId !== source.branch_id
                || result.filesystem.targetBranchId !== temporary || result.filesystem.sourcePath !== (source.native_scope ?? ''))
                throw new Error('Workspace snapshot identity changed');
        }
        else {
            await actor.forkWorkspace({ branchId: source.branch_id!, generation: entry.view.binding.generation, targetBranchId: temporary, operationId,
                ...(source.native_scope ? { sourcePath: source.native_scope } : {}) }, signal);
        }
        const drafts = options.editorDrafts ?? [];
        if (drafts.length && !await actor.getOperation(`snapshot-overlay:${operationId}`, signal)) {
            const paths = withAncestorDirectories(drafts.map(draft => draft.path));
            const original = await actor.readBranch({ branchId: temporary, paths, includeEntries: true }, signal);
            const existing = new Map(original.entries.map(entry => [entry.path, entry.state]));
            const changes: KernelBranchChange[] = [], owners: string[] = [];
            try {
                for (const selected of paths) {
                    const draft = drafts.find(item => item.path === selected), prior = existing.get(selected);
                    if (draft) {
                        const body = await actor.putBlob(draft.content, `snapshot-draft:${randomUUID()}`, signal);
                        owners.push(body.ownerId);
                        changes.push({ path: selected, state: { kind: 'regular-file', objectHash: body.hash, byteLength: body.byteLength, mode: prior?.kind === 'regular-file' ? prior.mode : 0o666 & ~process.umask() }, ownerId: body.ownerId });
                    }
                    else if (prior?.kind !== 'directory')
                        changes.push({ path: selected, state: { kind: 'directory', mode: 0o755 } });
                }
                const written = await actor.writeBranch({ operationId: `snapshot-overlay:${operationId}`, branchId: temporary, expectedWriteRevision: original.writeRevision, changes }, signal);
                if (written.status !== 'committed')
                    throw new Error('The fixed draft overlay changed during preparation');
            }
            finally {
                for (const owner of owners)
                    await actor.releaseBlob(owner);
            }
        }
        await options.beforePublish?.(actor, temporary);
        const current = drafts.length ? await actor.readBranch({ branchId: temporary, includeEntries: false }, signal) : undefined;
        const pin = await actor.pinBranch({ operationId: `snapshot-pin:${operationId}`, branchId: temporary, ...(current ? { expectedRoot: current.root, expectedWriteRevision: current.writeRevision } : { revision: 0 }) }, signal);
        if (typeof pin.pinId !== 'string' || typeof pin.root !== 'string')
            throw new Error('Native snapshot pin is incomplete');
        const pinId = pin.pinId;
        let provenance: Awaited<ReturnType<typeof actor.putBlob>> | undefined;
        let transferred = false;
        try {
            provenance = await actor.putBlob(Buffer.from(JSON.stringify({ consistency: 'fixed-root', root: pin.root, ...(options.selection ? { selection: options.selection } : {}), ...(options.resources ? { resources: options.resources } : {}) })), `snapshot-provenance:${randomUUID()}`, signal);
            const branch = await actor.forkBranch({ workspaceId: source.workspace_id, branchId: targetBranchId, operationId: `branch-fork:${targetBranchId}`,
                sourceBranchId: temporary, sourcePinId: pinId, parentRef, draftBasePaths: drafts.map(item => item.path).sort(), captureScopes: options.selection?.captureScopes ?? [], sourceProvenance: { objectHash: provenance.hash, ownerId: provenance.ownerId } }, signal);
            transferred = branch.created === true;
        }
        finally {
            if (!transferred && provenance)
                await actor.releaseBlob(provenance.ownerId);
            await actor.unpinBranch({ operationId: `snapshot-unpin:${operationId}`, branchId: temporary, pinId });
        }
        await actor.deleteBranch({ operationId: `snapshot-cleanup:${operationId}`, branchId: temporary }, signal);
        await retainPreparation(temporary, true);
    };
    /** Retire a mount only after its original resources have drained. The branch
     * and its saved versions remain owned by their existing references. */
    const releaseSource = async (source: Source) => {
        if ((await owners.projects()).some(project => project.versionedWorkspace?.branchId === source.branch_id && project.versionedWorkspace.state !== 'disabled'))
            return;
        const branch = source.branch_id;
        if (!branch)
            return;
        const entry = opened.get(branch);
        if (!entry || entry.epoch !== owners.kernel.handshake?.kernelEpoch)
            return;
        const actor = owners.kernel.scoped(entry.grant);
        const view = await actor.inspectWorkspace({ branchId: branch, generation: entry.view.binding.generation });
        try {
            await actor.closeWorkspace({ branchId: branch, generation: entry.view.binding.generation });
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('workspace_in_use'))
                return;
            entry.view = await actor.inspectWorkspace({ branchId: branch, generation: entry.view.binding.generation }).catch(() => entry.view);
            throw error;
        }
        await owners.kernel.revokeGrant(entry.grant.grantId);
        opened.delete(branch);
    };
    const retainReference = async (source: Source, key: string, signal?: AbortSignal) => {
        let held = references.get(key);
        if (held) {
            const previous = await held;
            if (previous.epoch === owners.kernel.handshake?.kernelEpoch) {
                if (previous.source.workspace_id !== source.workspace_id || previous.source.execution_workspace_id !== source.execution_workspace_id
                    || previous.source.branch_id !== source.branch_id || (previous.source.native_scope ?? '') !== (source.native_scope ?? ''))
                    throw new Error('Native resource reference changed source');
                return acquire(source, previous.grant, signal);
            }
            references.delete(key);
            held = undefined;
        }
        const work = (async () => {
            await open(source, signal);
            const grant = await owners.kernel.issueGrant({ grantId: `native-reference:${randomUUID()}`, owningWorkspace: source.workspace_id,
                executionWorkspace: source.execution_workspace_id, capabilities: ['storage.read'], pathScopes: [''] }, signal);
            try {
                await acquire(source, grant, signal);
                return { epoch: owners.kernel.handshake!.kernelEpoch, grant, source: { ...source } };
            }
            catch (error) {
                await owners.kernel.revokeGrant(grant.grantId);
                throw error;
            }
        })();
        references.set(key, work);
        try {
            const reference = await work;
            return acquire(source, reference.grant, signal);
        }
        catch (error) {
            if (references.get(key) === work)
                references.delete(key);
            throw error;
        }
    };
    const releaseReference = async (key: string) => {
        const work = references.get(key);
        if (!work)
            return;
        const reference = await work;
        if (reference.epoch === owners.kernel.handshake?.kernelEpoch) {
            await owners.kernel.revokeGrant(reference.grant.grantId);
            await releaseSource(reference.source);
        }
        if (references.get(key) === work)
            references.delete(key);
    };
    const retireSource = async (source: Source, cleanupId: string, signal?: AbortSignal): Promise<boolean> => {
        const branch = source.branch_id;
        if (!branch || retiring.has(branch))
            return false;
        retiring.add(branch);
        let claimed = false, deleted = false;
        try {
            const flight = opening.get(branch);
            if (flight)
                await flight.work.catch(() => undefined);
            if (!await owners.documents.canReleaseNativeSource(source)) {
                await owners.kernel.agentRuntimeRequest('runtime.source.retirement', { cleanupId, defer: true }, signal);
                return false;
            }
            const claim = await owners.kernel.agentRuntimeRequest('runtime.source.retirement', { cleanupId }, signal) as {
                claimed: boolean;
            };
            if (!claim.claimed)
                return false;
            claimed = true;
            const original = opened.get(branch);
            try {
                await releaseSource(original?.source ?? source);
            }
            catch (error) {
                if (error instanceof Error && /workspace_(?:in_use|native_handles_active)/.test(error.message))
                    return false;
                throw error;
            }
            if (opened.has(branch) && opened.get(branch)?.epoch === owners.kernel.handshake?.kernelEpoch)
                return false;
            const grant = await owners.kernel.issueGrant({ grantId: `source-cleanup:${randomUUID()}`, owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id, capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }, signal);
            try {
                const actor = owners.kernel.scoped(grant);
                if (branch.startsWith('child-source:'))
                    await actor.unpinBranch({ operationId: `source-cleanup-pin:${cleanupId}`, branchId: branch, pinId: `child-source-pin:${branch.slice('child-source:'.length)}` }, signal);
                if (branch.startsWith('native-snapshot:')) {
                    const original = await actor.getOperation(`snapshot-pin:${branch.slice('native-snapshot:'.length)}`, signal);
                    const pin = (original?.result as {
                        pinId?: string;
                    } | undefined)?.pinId;
                    if (pin)
                        await actor.unpinBranch({ operationId: `source-cleanup-pin:${cleanupId}`, branchId: branch, pinId: pin }, signal);
                }
                await actor.deleteBranch({ operationId: `source-cleanup:${cleanupId}`, branchId: branch }, signal);
                deleted = true;
            }
            finally {
                await owners.kernel.revokeGrant(grant.grantId);
            }
            await owners.documents.forgetNativeSource(source);
            await owners.kernel.agentRuntimeRequest('runtime.source.retirement', { cleanupId, complete: true }, signal);
            for (const [id, selected] of known)
                if (selected.branch_id === branch)
                    known.delete(id);
            for (const [id, selected] of documentViews)
                if (selected.branch_id === branch)
                    documentViews.delete(id);
            return true;
        }
        finally {
            try {
                if (claimed && !deleted)
                    await owners.kernel.agentRuntimeRequest('runtime.source.retirement', { cleanupId, defer: true });
            }
            finally {
                retiring.delete(branch);
            }
        }
    };
    return { prepare, acquire, resolveId, resolvePath, enable, disable, inspectProject, open, snapshot, releaseSource, retainReference, releaseReference, retireSource, retainPrepared };
}
export type NativeWorkspaceOwner = ReturnType<typeof createNativeWorkspaceOwner>;
