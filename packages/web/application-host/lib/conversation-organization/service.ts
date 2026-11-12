import { createHash } from 'node:crypto';
import { ConversationOrganizationError, ExternalAgentError, freezeProjectSourceSelection, projectContainsPath, type ConversationOrganizationCommand, type ConversationOrganizationQuery, type ConversationOrganizationMetadataItem, type ConversationOrganizationMetadataResult, type ProjectEntry } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ThreadAdapter } from '../kernel/thread-adapter.js';
import type { ExternalAgentsService } from '../external-agents/service.js';
import { KernelClientError, KernelRequestError } from '../kernel/kernel-error.js';

export interface ConversationOrganizationDependencies {
  runtime: AgentRuntimeClient;
  threads: Pick<ThreadAdapter, 'update' | 'delete'>;
  external: Pick<ExternalAgentsService, 'list' | 'inspect' | 'update'>;
  readSettings(): Promise<{ projects?: unknown }>;
}
/** No mirrored directory or receipt store: all navigation commits are Catalog commands. */
export class ConversationOrganizationService {
  constructor(private readonly deps: ConversationOrganizationDependencies) {}
  private async projects(): Promise<ProjectEntry[]> {
    try {
      const settings = await this.deps.readSettings();
      if (settings.projects === undefined) return [];
      if (!Array.isArray(settings.projects)) throw new Error('Saved projects are not an array');
      const ids = new Set<string>();
      return settings.projects.map(value => {
        if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)
          || typeof value.path !== 'string' || !value.path.trim() || value.label !== undefined && typeof value.label !== 'string') throw new Error('Saved project identity or source is invalid');
        ids.add(value.id); return value as ProjectEntry;
      });
    } catch (error) { throw new ConversationOrganizationError('projects_unavailable', error instanceof Error ? error.message : 'Saved projects are unavailable', 503); }
  }
  async entry(principalId: string | null, conversation: import('@varin/application-client').ConversationOrganizationRef, signal?: AbortSignal) {
    return this.deps.runtime.organizationEntry(principalId, conversation, signal);
  }
  async read(principalId: string | null, query: ConversationOrganizationQuery = {}, signal?: AbortSignal) {
    // Search names belong to Settings, not copied navigation metadata. Resolve one
    // generation per request; the Catalog binds this trusted index into its cursor.
    const searchProjects = query.query?.trim() ? await this.projects() : undefined;
    const ownerQuery = searchProjects ? { ...query, projectNames: Object.fromEntries(searchProjects.map(project => [project.id, project.label || project.path])) } : query;
    signal?.throwIfAborted();
    const current = await this.deps.runtime.organizationRead(principalId, ownerQuery, signal);
    if (current.initialized) return current;
    // Only a successfully read, structurally valid generation can initialize the Catalog.
    const projects = searchProjects ?? await this.projects();
    const [threads, external] = await Promise.all([
      this.deps.runtime.threadCatalog({ archived: 'include', principalId }, signal), this.deps.external.list(signal),
    ]);
    const known = new Set(projects.map(project => project.id));
    const positions = threads.filter(thread => (thread.principal_id ?? null) === null || thread.principal_id === principalId).map(thread => {
      const ids = [...new Set(thread.observer_project_ids.filter((id): id is string => id !== null && known.has(id)))];
      return { conversation: { kind: 'native' as const, id: thread.thread_id }, projectId: ids.length === 1 ? ids[0]! : null };
    });
    const externalPositions = external.filter(value => !value.deleted && (value.principalId ?? null) === principalId).map(value => {
      const source = value.executionSource ?? value.nativeWorkspace;
      const owner = source?.resource_owner ?? { kind: 'local' as const };
      const workspace = source?.workspace_id ?? value.workspaceId;
      const sameOwner = projects.filter(project => {
        const candidate = project.source?.resourceOwner ?? { kind: 'local' as const };
        return candidate.kind === owner.kind && (candidate.kind === 'local' ||
          (owner.kind === 'managed_host' && candidate.hostId === owner.hostId &&
            candidate.connectionId === owner.connectionId && candidate.endpointIdentity === owner.endpointIdentity));
      });
      // A typed source's logical workspace survives mount/cwd changes. Never infer
      // its owner from a path, or fall back after a declared identity no longer matches.
      const identified = workspace ? sameOwner.filter(project => project.source?.workspaceId === workspace ||
        (project.versionedWorkspace?.state === 'ready' && project.versionedWorkspace.workspaceId === workspace)) : [];
      const matches = source || identified.length ? identified : sameOwner.filter(project =>
        (!workspace || !project.source) && projectContainsPath(project, value.cwd));
      return { conversation: { kind: 'external' as const, id: value.id }, projectId: matches.length === 1 ? matches[0]!.id : null };
    });
    signal?.throwIfAborted();
    await this.deps.runtime.organizationInitialize(principalId, { key: 'visible-project-generation', projects: projects.map(({ id }) => ({ id })), positions: [...positions, ...externalPositions] }, signal);
    return this.deps.runtime.organizationRead(principalId, ownerQuery, signal);
  }
  async creationDefaults(principalId: string | null, threadId: string, placement: import('@varin/application-client').ConversationOrganizationPlacement): Promise<import('@varin/application-client').ConversationCreationDefaults | null> {
    try {
      const thread = await this.deps.runtime.thread(threadId);
      if ((thread.principal_id ?? null) !== principalId) throw new ConversationOrganizationError('forbidden', 'Conversation belongs to another user', 403);
      // The original creation intent, not current Settings, owns an uncertain retry.
      const saved = await this.deps.runtime.organizationCreationDefaults(threadId);
      // Legacy placement receipts did not carry a supplied source descriptor; do not
      // retrofit one (or change their original intent) while retrying creation.
      return saved?.source ? saved : null;
    } catch (error) {
      if (!(error instanceof KernelClientError) || !['not-found', 'not_found'].includes(error.code)) throw error;
    }
    const snapshot = await this.read(principalId, { limit: 1 });
    const containers = new Map(snapshot.containers.map(container => [container.id, container]));
    let id = placement.containerId, projectId: string | null = null;
    const visited = new Set<string>();
    while (id !== null) {
      if (visited.has(id)) throw new ConversationOrganizationError('conflict', 'Container ancestry changed', 409); visited.add(id);
      const container = containers.get(id); if (!container) throw new ConversationOrganizationError('conflict', 'Selected container no longer exists', 409);
      if (container.kind === 'project') { projectId = container.projectId; break; }
      id = container.parentId;
    }
    if (projectId === null) return null;
    const project = (await this.projects()).find(project => project.id === projectId);
    if (!project) throw new ConversationOrganizationError('not_found', 'The selected project is no longer registered', 404);
    return { projectId, source: { selection: freezeProjectSourceSelection(project), resourceOwner: project.source?.resourceOwner ?? { kind: 'local' }, path: project.path,
      ...(project.source?.workspaceId || project.versionedWorkspace?.state === 'ready' ? { workspaceId: project.source?.workspaceId ?? project.versionedWorkspace!.workspaceId } : {}) } };
  }
  async command(principalId: string | null, input: ConversationOrganizationCommand, signal?: AbortSignal) {
    const receipt = await this.deps.runtime.organizationReceipt(principalId, input, signal);
    if (receipt !== null) return receipt;
    await this.read(principalId, { limit: 1 }, signal);
    if (input.operation.action === 'create' && input.operation.kind === 'project') {
      const projects = await this.projects();
      const projectId = input.operation.projectId;
      if (!projects.some(project => project.id === projectId)) throw new ConversationOrganizationError('not_found', 'Register this project with its project owner before adding its navigation reference', 404);
    }
    return this.deps.runtime.organizationCommand(principalId, input, signal);
  }
  async project(principalId: string | null, projectId: string, command: ConversationOrganizationCommand, signal?: AbortSignal): Promise<import('@varin/application-client').ConversationOrganizationProjectResult> {
    const registered = (await this.projects()).some(project => project.id === projectId);
    try {
      const previous = await this.deps.runtime.organizationReceipt(principalId, command, signal);
      if (previous !== null) return { projectId, registered, navigation: 'completed', receipt: previous };
      const operation = command.operation;
      if (operation.action === 'create') {
        if (!registered || operation.kind !== 'project' || operation.projectId !== projectId) throw new ConversationOrganizationError('conflict', 'Project registration does not match the navigation command', 409);
      } else if (operation.action === 'dissolve') {
        if (registered) throw new ConversationOrganizationError('conflict', 'Remove the project registration with its original owner first', 409);
        const current = await this.deps.runtime.organizationRead(principalId, { limit: 1 }, signal);
        const container = current.containers.find(value => value.id === operation.id);
        if (container && (container.kind !== 'project' || container.projectId !== projectId)) throw new ConversationOrganizationError('conflict', 'Navigation container does not refer to this project', 409);
      } else throw new ConversationOrganizationError('invalid_request', 'Project coordination accepts registration or removal only');
      const receipt = await this.deps.runtime.organizationCommand(principalId, command, signal);
      return { projectId, registered, navigation: 'completed', receipt };
    } catch (error) {
      signal?.throwIfAborted();
      return { projectId, registered, navigation: 'pending', failure: { code: error instanceof ConversationOrganizationError ? error.code : error instanceof KernelClientError && /^(?:operation error: )?conflict:/.test(error.message) ? 'conflict' : 'unknown_outcome', message: error instanceof Error ? error.message : String(error) } };
    }
  }
  async metadata(principalId: string | null, key: string, items: ConversationOrganizationMetadataItem[], signal?: AbortSignal) {
    const results: ConversationOrganizationMetadataResult[] = [];
    // The caller submits the fixed actual selection, not a moving container query.
    for (const item of items) {
      signal?.throwIfAborted();
      try {
        const ref = item.conversation;
        const owner = ref.kind === 'native' ? (await this.deps.runtime.thread(ref.id, signal)).principal_id
          : (await this.deps.external.inspect(ref.id, signal)).principalId;
        if ((owner ?? null) !== principalId) {
          const publicNative = ref.kind === 'native' && owner === null;
          if (!publicNative || !await this.deps.runtime.principalCanUseHostResources?.(principalId)) throw new ConversationOrganizationError('forbidden', 'Conversation changes require its original user or the Host owner for public work', 403);
        }
        const receiptKey = `organization:${createHash('sha256').update(JSON.stringify([key, ref.kind, ref.id])).digest('hex')}`;
        const { deleted: _deleted, ...metadataPatch } = item.patch;
        const result = ref.kind === 'external'
          ? await this.deps.external.update(ref.id, item.expectedRevision, item.patch, receiptKey)
          : item.patch.deleted
            ? await this.deps.threads.delete({ runtime: 'agent', threadId: ref.id, key: receiptKey, expectedRevision: item.expectedRevision })
            : await this.deps.threads.update({ runtime: 'agent', threadId: ref.id, key: receiptKey, expectedRevision: item.expectedRevision, ...metadataPatch });
        results.push({ conversation: ref, status: 'succeeded', result });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown_outcome';
        const message = error instanceof Error ? error.message : String(error);
        const known = error instanceof ConversationOrganizationError || error instanceof ExternalAgentError || error instanceof KernelClientError && (!(error instanceof KernelRequestError) || error.settlement === 'response');
        const status = /conflict/.test(code) || /^(?:operation error: )?conflict:/.test(message) ? 'conflict' : /busy|turn_active/.test(code) ? 'busy' : known ? 'failed' : 'unknown';
        results.push({ conversation: item.conversation, status, code, message });
      }
    }
    return { items: results };
  }
}
