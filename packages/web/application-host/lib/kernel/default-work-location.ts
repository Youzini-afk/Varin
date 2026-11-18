import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { resourceThreadSource } from './thread-context.js';
import { freezeProjectSourceSelection, parseWorkspaceLocations, parseDefaultWorkspaceLocationId, workspaceLocationSource,
  type ThreadLocationDirectory, type ProjectEntry, type ProjectSourceSelection, type ThreadIdentity, type ThreadPrepareSource, type ThreadPreparedSource } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { SourceDirectory } from './thread-sources.js';
import { SourceAdmissionError } from './source-admission-error.js';

/** Only for a first use, after branch history/explicit chat-only and task limits
 * have been considered. Never substitute the coordinator when a saved owner is unavailable. */
export function preferredWorkLocation(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown }, projects: ProjectEntry[]) {
  const id = parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null);
  if (id === null) return null;
  const selected = parseWorkspaceLocations(settings.workspaceLocations).find(row => row.id === id);
  if (!selected) throw new Error('The default workspace location is no longer saved; choose another location');
  return workspaceLocationSource(selected, projects);
}

export async function prepareWorkLocation(identity: ThreadIdentity, key: string,
  location: { resourceOwner: SourceResourceOwner; path: string; workspaceId?: string | null; selection?: ProjectSourceSelection },
  directory: Pick<SourceDirectory, 'resolve'>,
  prepare: (input: ThreadPrepareSource, signal?: AbortSignal) => Promise<ThreadPreparedSource>, signal?: AbortSignal) {
  const selected = location.selection?.mode === 'native_workspace'
    ? { resourceOwner: location.resourceOwner, workspaceId: location.selection.workspaceId }
    : await directory.resolve({ resourceOwner: location.resourceOwner, path: location.path }, signal);
  if (!isDeepStrictEqual(location.resourceOwner, selected.resourceOwner) || location.workspaceId && selected.workspaceId !== location.workspaceId) {
    throw new SourceAdmissionError('source_changed');
  }
  return (await prepare({ ...identity, key, resourceOwner: selected.resourceOwner, workspaceId: selected.workspaceId,
    mode: location.selection?.mode ?? 'live_root', ...(location.selection ? { selection: location.selection } : {}),
    content: { mode: 'saved-files' }, captureScopes: [] }, signal)).source;
}

export function listWorkLocations(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown },
  projects: ProjectEntry[], servicePath: string): ThreadLocationDirectory & { projects: ThreadLocationDirectory['locations'] } {
  const favorites = parseWorkspaceLocations(settings.workspaceLocations ?? []);
  return { servicePath, defaultId: parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null),
    projects: projects.filter(project => !favorites.some(row => row.kind === 'project' && row.projectId === project.id)).map(project => {
      const id = `project:${project.id}`;
      return { id, ...workspaceLocationSource({ kind: 'project', id, projectId: project.id }, projects) };
    }),
    locations: favorites.map(row => {
      if (row.kind === 'project' && !projects.some(project => project.id === row.projectId)) {
        return { id: row.id, name: row.projectId, unavailable: 'Project no longer registered' };
      }
      const { name, resourceOwner, path, workspaceId, selection } = workspaceLocationSource(row, projects);
      return { id: row.id, name, resourceOwner, path, ...(workspaceId ? { workspaceId } : {}), ...(selection ? { selection } : {}) };
    }) };
}

/** The ordinary native input and cold work paths share this resolver. A completed
 * branch, even with no source, is not eligible for creation preferences. */
export function createConversationWorkLocation({ agentRuntime, sourceDirectory, readWorkspaceSettings, prepare, getBot, servicePath }: {
  agentRuntime: Pick<AgentRuntimeClient, 'thread' | 'context' | 'launch' | 'sourceTools' | 'principalCanUseHostResources' | 'organizationCreationDefaults'>;
  sourceDirectory: Pick<SourceDirectory, 'resolve'>;
  readWorkspaceSettings(): Promise<{ projects: ProjectEntry[]; workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown }>;
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  getBot(id: string): Promise<{ homeDir: string } | null | undefined>;
  servicePath: string;
}) {
  return async (identity: ThreadIdentity) => {
    const thread = await agentRuntime.thread(identity.threadId);
    const latest = thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run;
    const checkpoint = await agentRuntime.context(identity.branchId);
    const inherited = checkpoint?.resources ? checkpoint.resources.source : (latest ? (await agentRuntime.launch(latest.id))?.selection.source : null);
    if (inherited) {
      const source = resourceThreadSource(inherited);
      if (!source) throw new Error('The inherited execution source is unavailable');
      return { ...source, tools: await agentRuntime.sourceTools(source.mode) };
    }
    // A completed source-less round (including explicit chat only) is itself an
    // execution choice. Creation defaults are only for a genuinely empty branch.
    if (latest || checkpoint?.resources) return null;
    // An empty/checkpoint-less child is not a new ordinary conversation, and a
    // host-wide preference can never grant a guest use of the Host's resources.
    if (thread.parent_thread_id || !await agentRuntime.principalCanUseHostResources?.(thread.principal_id)) return null;
    const defaults = await agentRuntime.organizationCreationDefaults(identity.threadId);
    const key = `creation-location:${identity.threadId}:${identity.branchId}`;
    if (defaults?.source) return prepareWorkLocation(identity, key, defaults.source, sourceDirectory, prepare);
    if (defaults?.projectId) {
      const project = (await readWorkspaceSettings()).projects.find(project => project.id === defaults.projectId);
      if (!project) throw new Error('The conversation’s original default project is no longer registered. Select a source explicitly.');
      return prepareWorkLocation(identity, key, { path: project.path, resourceOwner: project.source?.resourceOwner ?? { kind: 'local' },
        ...(project.source ? { workspaceId: project.source.workspaceId } : {}), selection: freezeProjectSourceSelection(project) }, sourceDirectory, prepare);
    }
    if (thread.bot_id) {
      const bot = await getBot(thread.bot_id);
      if (!bot) throw new Error('The original Bot workspace is unavailable');
      return prepareWorkLocation(identity, key, { resourceOwner: { kind: 'local' }, path: bot.homeDir }, sourceDirectory, prepare);
    }
    const saved = await readWorkspaceSettings();
    const preferred = preferredWorkLocation(saved, saved.projects);
    return prepareWorkLocation(identity, key, preferred ?? { resourceOwner: { kind: 'local' }, path: servicePath }, sourceDirectory, prepare);
  };
}
