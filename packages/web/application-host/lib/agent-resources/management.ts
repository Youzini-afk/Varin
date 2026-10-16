import path from 'node:path';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
  NativeResourceCatalogSnapshot, NativeResourceCopy, NativeResourceCreate, NativeResourceDescriptor,
  NativeResourceDocumentSnapshot, NativeResourceRemove, NativeResourceScope, NativeResourceUpdate, ResourceManagementTarget,
} from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import { revisionFromBytes } from '../documents/inspect.js';
import type { AgentSettingsService } from '../models/settings.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';
import { createAgentResourceAuthority, type ResourceCatalogCandidate, type ResourceCatalogScope, type ResourceDomain } from './authority.js';
import { isLocalPattern, readResourceSettings } from './configuration.js';
import { parseSkill } from './formats.js';
import { readAgentResourceConfiguration, resourceDirectory } from './packages.js';
import { contentVersion, createAdmittedDirectoryReader } from './source-reader.js';
import { agentSystemSections } from './render.js';
import type { AgentSystemPromptPreview } from '@varin/protocol';

export class ResourceManagementFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new ResourceManagementFailure(400, 'resource-invalid', message); };
const conflict = (message = 'Resource changed. Reload before saving.'): never => { throw new ResourceManagementFailure(409, 'resource-conflict', message); };
const required = (value: unknown, label: string): string => typeof value === 'string' && value.trim() ? value : invalid(`${label} is required.`);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, fields: string[]) => { if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('Unsupported resource request fields.'); };
const resourceId = (canonicalId: string) => `skill:${contentVersion(canonicalId)}`;
const nativeScope = (candidate: ResourceCatalogCandidate): NativeResourceScope => candidate.requiresProjectTrust ? 'project' : 'user';
const canonical = (value: string) => canonicalizePathIdentity(value, { allowMissing: true });

export interface ResourceManagementDependencies {
  dataDirectory: string;
  documents: Pick<DocumentAuthority, 'ensureResourceRoot' | 'read' | 'write' | 'delete' | 'inspectMutation'>;
  settings: Pick<AgentSettingsService, 'snapshot' | 'projectTrusted'>;
  /** Resolve only a saved Host project identity. Do not accept a path as a project ID. */
  resolveProjectRoot(projectId: string): string | null | Promise<string | null>;
  userAgentsDirectory?: string;
}

/** Authenticated editor owner. Discovery is shared with native Runs, but this current view never
 * claims to be an execution checkpoint. All content mutation goes through Documents/Rust file CAS. */
export function createResourceManagement(deps: ResourceManagementDependencies) {
  const authority = createAgentResourceAuthority();
  async function targetScope(target: ResourceManagementTarget) {
    exact(target, ['projectId']);
    let projectRoot: string | undefined;
    if (target.projectId !== undefined) {
      const resolved = await deps.resolveProjectRoot(required(target.projectId, 'projectId'));
      if (!resolved) throw new ResourceManagementFailure(404, 'project-missing', 'Project is not registered on this Host.');
      projectRoot = await canonical(resolved);
    }
    const dataRoot = await canonical(deps.dataDirectory);
    const projectTrusted = !!projectRoot && deps.settings.projectTrusted(projectRoot);
    const assertTrust = () => {
      if (projectTrusted && !deps.settings.projectTrusted(projectRoot!)) throw new ResourceManagementFailure(403, 'project-trust-revoked', 'Project trust changed. Reload resources.');
    };
    return { dataRoot, projectRoot, projectTrusted, assertTrust };
  }
  async function domain(root: string, name: string, directory?: string): Promise<ResourceDomain> {
    const admitted = await canonical(root);
    // This is existing backend resource addressing, not a conversation/workspace identity or UI grant.
    await deps.documents.ensureResourceRoot(admitted, 'directory');
    return { reader: await createAdmittedDirectoryReader({ root: admitted, domainId: `resource-management:${name}`, viewId: `current:${contentVersion(admitted)}` }), displayRoot: admitted, ...(directory ? { directory } : {}) };
  }
  async function withCurrentScope<T>(target: ResourceManagementTarget,
    consume: (scope: ResourceCatalogScope, context: Awaited<ReturnType<typeof targetScope>>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const context = await targetScope(target);
    const { dataRoot, projectRoot, projectTrusted, assertTrust } = context;
    const snapshot = await deps.settings.snapshot(projectRoot);
    assertTrust();
    const scope: ResourceCatalogScope = {
      projectTrusted, user: await domain(resourceDirectory(dataRoot), 'user'), userSettings: await domain(dataRoot, 'settings'),
      ...(projectRoot && projectTrusted ? { project: { ...await domain(projectRoot, 'project'), cwd: '' } } : {}),
      configuredPaths: [], installedPackages: [], dependencyDiagnostics: [],
    };
    const optionalDomain = async (root: string, name: string, directory?: string) => {
      try { return await domain(root, name, directory); }
      catch (error) {
        const denied = (error as { statusCode?: number }).statusCode === 403;
        scope.dependencyDiagnostics!.push({ domainId: `resource-management:${name}`, viewId: 'current', path: root,
          status: denied ? 'denied' : 'unavailable', reason: denied ? 'Resource source is outside the Host deployment boundary' : 'Resource source is unavailable' });
        return undefined;
      }
    };
    const userAgents = await optionalDomain(deps.userAgentsDirectory ?? path.join(homedir(), '.agents'), 'user-agents');
    if (userAgents) scope.userAgents = userAgents;
    for (const [kind, document, root] of [
      ['user', snapshot.global, resourceDirectory(dataRoot)],
      ...(projectTrusted ? [['project', snapshot.project, resourceDirectory(dataRoot, projectRoot)] as const] : []),
    ] as const) {
      const resources = readResourceSettings(document);
      for (const configuredPath of resources.skills.filter(value => !isLocalPattern(value))) {
        const absolute = configuredPath === '~' ? homedir() : /^~[/\\]/.test(configuredPath) ? path.resolve(homedir(), configuredPath.slice(2)) : path.resolve(root, configuredPath);
        let isFile = false;
        try { isFile = (await stat(absolute)).isFile(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const admitted = await optionalDomain(isFile ? path.dirname(absolute) : absolute, `configured:${kind}:${contentVersion(configuredPath)}`, isFile ? path.basename(absolute) : undefined);
        if (admitted) scope.configuredPaths!.push({ scope: kind, configuredPath, target: admitted });
      }
      const installed = await readAgentResourceConfiguration({ dataDirectory: dataRoot, settings: deps.settings, ...(kind === 'project' ? { cwd: projectRoot! } : {}), resources });
      for (const item of installed.packages) {
        const admitted = await optionalDomain(item.installedPath, `package:${kind}:${contentVersion(item.identity)}`);
        if (admitted) scope.installedPackages!.push({ ...admitted, identity: item.identity, source: item.source, scope: kind });
      }
    }
    assertTrust();
    const result = await consume(scope, context);
    const after = await deps.settings.snapshot(projectRoot);
    assertTrust();
    if (snapshot.globalRevision !== after.globalRevision || snapshot.projectRevision !== after.projectRevision) conflict('Resource configuration changed. Reload resources.');
    return result;
  }
  async function catalog(target: ResourceManagementTarget, signal?: AbortSignal) {
    return withCurrentScope(target, async (scope, context) => {
      const { dataRoot, projectRoot, projectTrusted } = context;
      const result = await authority.inspect(scope, signal);
      if (result.status !== 'ready') throw new ResourceManagementFailure(result.status === 'invalid' ? 422 : result.status === 'denied' ? 403 : 503, `resource-${result.status}`, result.reason);
      const active = new Set(result.skills.map(skill => skill.reference.canonicalId));
      const candidates = new Map<string, ResourceCatalogCandidate>();
      const descriptors = new Map<string, NativeResourceDescriptor>();
      const writableRoots = new Map<string, string>();
      for (const candidate of result.candidates) {
        const id = resourceId(candidate.file.reference.canonicalId);
        if (candidates.has(id)) continue;
        candidates.set(id, candidate);
        const filePath = candidate.file.reference.canonicalId.slice(5);
        let metadata: ReturnType<typeof parseSkill>['metadata'] = null;
        try { metadata = parseSkill(candidate.file.content, filePath).metadata; } catch { /* Invalid assets stay editable. */ }
        const sourceScope = nativeScope(candidate);
        const conventionalRoots = sourceScope === 'user'
          ? [path.join(resourceDirectory(dataRoot), 'skills'), path.join(deps.userAgentsDirectory ?? path.join(homedir(), '.agents'), 'skills')]
          : [path.join(resourceDirectory(dataRoot, projectRoot), 'skills'), path.join(projectRoot!, '.agents', 'skills')];
        const declaredPath = path.resolve(candidate.domain.displayRoot!, candidate.file.reference.path);
        // Configured external and package roots are read-only. Native convention roots are editable;
        // even an internal symlink does not become a write selector.
        const writableRoot = candidate.origin !== 'package' && declaredPath === filePath ? conventionalRoots.find(root => isPathWithinRoot(filePath, root)) : undefined;
        const writable = writableRoot !== undefined;
        if (writableRoot) writableRoots.set(id, writableRoot);
        descriptors.set(id, { id, kind: 'skill', filePath, name: metadata?.name ?? path.basename(path.dirname(filePath)), description: metadata?.description ?? '',
          valid: !!metadata, active: active.has(candidate.file.reference.canonicalId), writable,
          ...(metadata ? { disableModelInvocation: metadata.disableModelInvocation } : {}),
          sourceInfo: { origin: candidate.origin === 'package' ? 'package' : 'top-level', scope: sourceScope, path: candidate.domain.displayRoot!,
            source: candidate.packageIdentity ?? (sourceScope === 'user' ? 'Native user resources' : 'Native project resources'), baseDir: path.dirname(filePath) } });
      }
      const diagnostics = result.diagnostics.map(diagnostic => {
        const candidate = result.candidates.find(item => item.file.reference.domainId === diagnostic.location?.domainId && item.file.reference.viewId === diagnostic.location?.viewId && item.file.reference.path === diagnostic.location?.path);
        const descriptor = candidate && descriptors.get(resourceId(candidate.file.reference.canonicalId));
        return { kind: diagnostic.kind, message: diagnostic.message, ...(diagnostic.location ? { path: descriptor?.filePath ?? diagnostic.location.path } : {}),
          ...(descriptor ? { resourceId: descriptor.id } : {}),
          ...(diagnostic.kind === 'collision' && diagnostic.winner && descriptor ? { collision: { winnerPath: diagnostic.winner.canonicalId.slice(5), loserPath: descriptor.filePath, name: descriptor.name, resourceType: 'skill' as const } } : {}) };
      });
      return { ...context, candidates, descriptors, writableRoots, snapshot: { resources: [...descriptors.values()], projectTrusted, diagnostics } satisfies NativeResourceCatalogSnapshot };
    }, signal);
  }
  async function selected(target: ResourceManagementTarget, id: string, signal?: AbortSignal) {
    required(id, 'id');
    const view = await catalog(target, signal);
    const descriptor = view.descriptors.get(id), candidate = view.candidates.get(id);
    if (!descriptor || !candidate) throw new ResourceManagementFailure(404, 'resource-missing', 'Resource is not in this current native catalog.');
    return { view, descriptor, candidate };
  }
  async function address(filePath: string, root: string) {
    if (!isPathWithinRoot(filePath, root)) throw new ResourceManagementFailure(403, 'resource-denied', 'Resource is outside its native owner.');
    const mapping = await deps.documents.ensureResourceRoot(root, 'directory');
    return { workspaceId: mapping.workspaceId, resourceId: path.relative(root, filePath).split(path.sep).join('/') };
  }
  async function readSelection(selection: Awaited<ReturnType<typeof selected>>, signal?: AbortSignal): Promise<NativeResourceDocumentSnapshot> {
    const { view, descriptor, candidate } = selection;
    const root = view.writableRoots.get(descriptor.id) ?? path.dirname(descriptor.filePath);
    const document = await deps.documents.read(await address(descriptor.filePath, root), signal ? { signal } : {});
    view.assertTrust();
    if (document.status === 'missing') throw new ResourceManagementFailure(404, 'resource-missing', 'Resource no longer exists.');
    if (document.status !== 'ready') throw new ResourceManagementFailure(422, 'resource-invalid', 'Resource is not an editable text document.');
    if (document.revision !== revisionFromBytes(Buffer.from(candidate.file.content, 'utf8'))) conflict();
    return { descriptor, content: document.content, revision: document.revision, projectTrusted: view.projectTrusted };
  }
  async function write(target: ResourceManagementTarget, input: NativeResourceCreate | NativeResourceUpdate, signal?: AbortSignal, admittedTarget?: Awaited<ReturnType<typeof targetScope>>): Promise<NativeResourceDocumentSnapshot> {
    const create = 'scope' in input;
    exact(input, create ? ['scope', 'name', 'content', 'key'] : ['id', 'content', 'expectedRevision', 'key']);
    const key = required(input.key, 'key');
    if (typeof input.content !== 'string') invalid('content must be text.');
    signal?.throwIfAborted();
    const selection = create ? undefined : await selected(target, input.id, signal);
    const context = selection?.view ?? admittedTarget ?? await targetScope(target);
    let filePath: string;
    if (create) {
      if (input.scope !== 'user' && input.scope !== 'project') invalid('scope must be user or project.');
      const name = required(input.name, 'name');
      if (name !== name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.startsWith('.') || /[<>:"|?*]/.test(name) || /[. ]$/.test(name)) invalid('Use a visible skill directory name without path separators.');
      if (input.scope === 'project' && (!context.projectRoot || !context.projectTrusted)) throw new ResourceManagementFailure(403, 'project-not-trusted', 'Creating project skills requires a trusted project.');
      const root = path.join(resourceDirectory(context.dataRoot, input.scope === 'project' ? context.projectRoot : undefined), 'skills');
      filePath = path.join(root, name, 'SKILL.md');
      if (await canonical(filePath) !== filePath) throw new ResourceManagementFailure(403, 'resource-read-only', 'Skill destination traverses a symbolic link.');
    } else {
      required(input.expectedRevision, 'expectedRevision');
      if (!selection!.descriptor.writable) throw new ResourceManagementFailure(403, 'resource-read-only', 'Copy this read-only resource into native user or project skills before editing.');
      filePath = selection!.descriptor.filePath;
      if (await canonical(filePath) !== filePath) conflict('Resource path changed identity.');
    }
    // Keep resource-root addressing private. Existing Documents owns canonical identity, the mutation
    // token, Rust file CAS and operation recovery; no resource-management ledger is introduced.
    const sourceScope = create ? input.scope : selection!.descriptor.sourceInfo.scope;
    const resource = await address(filePath, selection?.view.writableRoots.get(selection.descriptor.id) ?? (sourceScope === 'user' ? context.dataRoot : context.projectRoot!));
    const current = await deps.documents.read(resource);
    context.assertTrust();
    signal?.throwIfAborted();
    const result = await deps.documents.write({ resource, token: { workspaceId: resource.workspaceId, epoch: current.epoch, owner: { kind: 'resource-editor', id: key } },
      content: input.content, encoding: current.status === 'ready' ? current.encoding : 'utf-8', bom: current.status === 'ready' ? current.bom : false,
      expectedRevision: create ? null : (input as NativeResourceUpdate).expectedRevision, operationId: key });
    if (result.status !== 'written') return conflict();
    // Return the confirmed owner's revision, not a later refresh that could hide a successful save.
    const id = resourceId(`file:${filePath}`);
    let metadata: ReturnType<typeof parseSkill>['metadata'] = null;
    try { metadata = parseSkill(input.content, filePath).metadata; } catch { /* Saved malformed content remains repairable. */ }
    const scope = create ? input.scope : selection!.descriptor.sourceInfo.scope;
    const descriptor: NativeResourceDescriptor = { id, kind: 'skill', filePath, name: metadata?.name ?? path.basename(path.dirname(filePath)), description: metadata?.description ?? '', valid: !!metadata,
      active: !!metadata && selection?.descriptor.active === true && selection.descriptor.name === metadata.name, writable: true, ...(metadata ? { disableModelInvocation: metadata.disableModelInvocation } : {}),
      sourceInfo: selection?.descriptor.sourceInfo ?? { origin: 'top-level', scope, path: resourceDirectory(context.dataRoot, scope === 'project' ? context.projectRoot : undefined), source: scope === 'user' ? 'Native user resources' : 'Native project resources', baseDir: path.dirname(filePath) } };
    return { descriptor, content: input.content, revision: result.revision, projectTrusted: context.projectTrusted };
  }
  return {
    async prompt(target: ResourceManagementTarget, signal?: AbortSignal): Promise<AgentSystemPromptPreview> {
      return withCurrentScope(target, async scope => {
        const result = await authority.preview(scope, signal);
        if (result.status !== 'ready') throw new ResourceManagementFailure(result.status === 'invalid' ? 422 : result.status === 'denied' ? 403 : 503, `resource-${result.status}`, result.reason);
        return { original: agentSystemSections(result.resources, 'main'), ...(target.projectId ? { projectId: target.projectId } : {}) };
      }, signal);
    },
    list: async (target: ResourceManagementTarget, signal?: AbortSignal) => (await catalog(target, signal)).snapshot,
    read: async (target: ResourceManagementTarget, id: string, signal?: AbortSignal) => readSelection(await selected(target, id, signal), signal),
    create: (target: ResourceManagementTarget, input: NativeResourceCreate, signal?: AbortSignal) => write(target, input, signal),
    update: (target: ResourceManagementTarget, input: NativeResourceUpdate, signal?: AbortSignal) => write(target, input, signal),
    async remove(target: ResourceManagementTarget, input: NativeResourceRemove, signal?: AbortSignal): Promise<{ removed: true }> {
      exact(input, ['id', 'expectedRevision', 'key']);
      required(input.expectedRevision, 'expectedRevision'); required(input.key, 'key');
      const selection = await selected(target, input.id, signal);
      if (!selection.descriptor.writable) throw new ResourceManagementFailure(403, 'resource-read-only', 'This resource is read-only.');
      const resource = await address(selection.descriptor.filePath, selection.view.writableRoots.get(selection.descriptor.id)!);
      const { epoch } = await deps.documents.inspectMutation(resource.workspaceId);
      selection.view.assertTrust(); signal?.throwIfAborted();
      const result = await deps.documents.delete({ resource, token: { workspaceId: resource.workspaceId, epoch, owner: { kind: 'resource-editor', id: input.key } }, expectedRevision: input.expectedRevision, operationId: input.key });
      if (result.status !== 'deleted') conflict();
      return { removed: true };
    },
    async copy(target: ResourceManagementTarget, input: NativeResourceCopy, signal?: AbortSignal) {
      exact(input, ['id', 'expectedRevision', 'key', 'scope', 'name']);
      const selection = await selected(target, input.id, signal);
      const source = await readSelection(selection, signal);
      if (source.revision !== required(input.expectedRevision, 'expectedRevision')) conflict('Source changed. Reload before copying.');
      // A copy is exactly the reviewed document, not a package installer or recursive bundle mutation.
      return write(target, { scope: input.scope, name: input.name, content: source.content, key: input.key }, signal, selection.view);
    },
  };
}
export type ResourceManagement = ReturnType<typeof createResourceManagement>;
