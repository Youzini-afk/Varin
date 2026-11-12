import { isDeepStrictEqual } from 'node:util';
import type { NativeResourceManagementCommand, ProjectEntry, ResourceManagementTarget } from '@varin/application-client';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import { ResourceManagementFailure, type ResourceManagement } from './management.js';

export async function invokeResourceManagement(owner: ResourceManagement, target: ResourceManagementTarget, command: NativeResourceManagementCommand, signal?: AbortSignal): Promise<unknown> {
  if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).some(key => !['action','input'].includes(key))
    || !command.input || typeof command.input !== 'object' || Array.isArray(command.input))
    throw new ResourceManagementFailure(400, 'resource-invalid', 'Invalid resource management command');
  if (['list','prompt','tools'].includes(command.action) && Object.keys(command.input).length
    || command.action === 'read' && (Object.keys(command.input).some(key => key !== 'id') || typeof command.input.id !== 'string'))
    throw new ResourceManagementFailure(400, 'resource-invalid', 'Unsupported resource command fields');
  switch (command.action) {
    case 'list': return owner.list(target, signal);
    case 'prompt': return owner.prompt(target, signal);
    case 'tools': return owner.toolCatalog(target, signal);
    case 'read': return owner.read(target, command.input.id, signal);
    case 'create': return owner.create(target, command.input, signal);
    case 'update': return owner.update(target, command.input, signal);
    case 'remove': return owner.remove(target, command.input, signal);
    case 'copy': return owner.copy(target, command.input, signal);
    default: throw new ResourceManagementFailure(400, 'resource-invalid', 'Unknown resource management action');
  }
}

/** Choose the original registered owner before any local path admission. */
export function routeProjectResourceManagement(local: ResourceManagement, options: {
  coordinatorHostId: string; projects(): Promise<ProjectEntry[]>;
  remote(owner: Extract<NonNullable<ProjectEntry['source']>['resourceOwner'], {kind:'managed_host'}>, signal?: AbortSignal): Promise<ManagedSourceClient>;
}): ResourceManagement {
  const invoke = async (target: ResourceManagementTarget, command: NativeResourceManagementCommand, signal?: AbortSignal) => {
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['projectId','expectedSource'].includes(key)))
      throw new ResourceManagementFailure(400,'resource-invalid','Unsupported resource target');
    const project = target.projectId ? (await options.projects()).find(item => item.id === target.projectId) : undefined;
    if (target.projectId && !project) throw new ResourceManagementFailure(404,'project-missing','Project is not registered');
    if (target.expectedSource && !isDeepStrictEqual(project?.source, target.expectedSource))
      throw new ResourceManagementFailure(409,'project-changed','Project source changed. Reload resources.');
    if (project?.source?.resourceOwner.kind === 'managed_host') {
      const remote = await options.remote(project.source.resourceOwner,signal);
      return remote.projectManagement({coordinatorHostId:options.coordinatorHostId,projectId:project.id,workspaceId:project.source.workspaceId,
        command:{action:'resources',input:command}},signal);
    }
    return invokeResourceManagement(local,target.projectId ? {projectId:target.projectId} : {},command,signal);
  };
  return {
    list: async (target,signal) => await invoke(target,{action:'list',input:{}},signal) as Awaited<ReturnType<ResourceManagement['list']>>,
    read: async (target,id,signal) => await invoke(target,{action:'read',input:{id}},signal) as Awaited<ReturnType<ResourceManagement['read']>>,
    create: async (target,input,signal) => await invoke(target,{action:'create',input},signal) as Awaited<ReturnType<ResourceManagement['create']>>,
    update: async (target,input,signal) => await invoke(target,{action:'update',input},signal) as Awaited<ReturnType<ResourceManagement['update']>>,
    remove: async (target,input,signal) => await invoke(target,{action:'remove',input},signal) as Awaited<ReturnType<ResourceManagement['remove']>>,
    copy: async (target,input,signal) => await invoke(target,{action:'copy',input},signal) as Awaited<ReturnType<ResourceManagement['copy']>>,
    prompt: async (target,signal) => await invoke(target,{action:'prompt',input:{}},signal) as Awaited<ReturnType<ResourceManagement['prompt']>>,
    toolCatalog: async (target,signal) => await invoke(target,{action:'tools',input:{}},signal) as Awaited<ReturnType<ResourceManagement['toolCatalog']>>,
  };
}
