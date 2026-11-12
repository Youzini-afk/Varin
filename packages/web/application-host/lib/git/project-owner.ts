import path from 'node:path';
import { createGitHttpClient, parseProjectSourceSelection, projectGitLocation, PROJECT_GIT_CONFIGURATION_READ, PROJECT_GIT_CONFIGURATION_WRITE,
  PROJECT_GIT_DIRECTORYLESS, PROJECT_GIT_READ, PROJECT_GIT_INTEGRATION, type ProjectGitCommand } from '@varin/application-client';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import type { NativeWorkspaceOwner } from '../kernel/native-workspaces.js';
import { assertResourcePathAllowed } from '../workspace/resource-access.js';
import { canonicalizePathIdentity, isPathWithinRoot, normalizePathIdentity } from '../workspace/path-safety.js';
import { resolvePrimaryWorktreeRoot } from './index.js';
import type { ProjectGitDispatcher } from './project-dispatch.js';

const operations = new Set(Object.keys(createGitHttpClient()));
const contains = (root: string, candidate: string) => isPathWithinRoot(candidate, root);
const canonical = (value: string) => canonicalizePathIdentity(value, { allowMissing: true });
const samePath = (a: string, b: string) => normalizePathIdentity(a) === normalizePathIdentity(b);
/** Project admission is separate from the original Git handler/writer. All
 * command paths are resolved on this target, including Windows path semantics. */
export async function dispatchProjectGit(options: { dispatch: ProjectGitDispatcher; nativeWorkspaces?: Pick<NativeWorkspaceOwner, 'prepareSelection'> },
  principal: ManagedSourcePrincipal, workspaceId: string, registeredRoot: string, command: ProjectGitCommand, signal?: AbortSignal): Promise<unknown> {
  if (!command || !operations.has(command.operation) || !Array.isArray(command.args)) throw new Error('Invalid project Git command');
  const includes = (values: readonly string[]) => values.includes(command.operation);
  const require = (...capabilities: string[]) => { for (const capability of capabilities) if (!principal.capabilities.includes(capability)) throw new Error(`Target Git requires ${capability}`); };
  require('filesystem:read', 'terminal:use');
  if (!includes(PROJECT_GIT_READ)) require('filesystem:write', 'process:control');
  if (includes(PROJECT_GIT_CONFIGURATION_READ)) require('config:read');
  if (includes(PROJECT_GIT_CONFIGURATION_WRITE)) require('config:write');
  const selection = parseProjectSourceSelection(command.selection);
  await assertResourcePathAllowed(registeredRoot, principal.allowedDirectories);
  const logicalRoot = await canonical(selection.mode === 'native_workspace' && selection.nativeScope
    ? path.resolve(registeredRoot, selection.nativeScope) : registeredRoot);
  let directory = logicalRoot;
  if (selection.mode === 'native_workspace') {
    if (selection.workspaceId !== workspaceId || !options.nativeWorkspaces) throw new Error('Original project adoption is unavailable');
    directory = (await options.nativeWorkspaces.prepareSelection(selection, `project-git:${principal.principalId}:${workspaceId}`, signal)).path;
  }
  const executionRoot = directory;
  const args: unknown[] = structuredClone(command.args);
  if (!includes(PROJECT_GIT_DIRECTORYLESS)) {
    if (typeof args[0] !== 'string') throw new Error('A project Git directory is required');
    // An opaque UI directory is a cache/selection key, never a target path.
    {
      const requested = await canonical(projectGitLocation(args[0])?.path ?? args[0]);
      if (selection.mode === 'native_workspace' && contains(directory, requested)) { directory = requested; } else {
      if (!contains(logicalRoot, requested)) {
        // Linked worktrees share the original repository but retain independent
        // Documents roots. Never authorize an arbitrary same-named directory.
        if (selection.mode !== 'live_root') throw new Error('Choose the original adopted project view');
        await assertResourcePathAllowed(requested, principal.allowedDirectories);
        const [expected, actual] = await Promise.all([resolvePrimaryWorktreeRoot(registeredRoot), resolvePrimaryWorktreeRoot(requested)]);
        if (!samePath(await canonical(expected.root), await canonical(actual.root))) throw new Error('Git directory belongs to another project repository');
        directory = requested;
      } else directory = path.resolve(directory, path.relative(logicalRoot, requested));
      }
    }
    const primary = await resolvePrimaryWorktreeRoot(directory);
    if (!contains(executionRoot, await canonical(primary.root))) await assertResourcePathAllowed(primary.root, principal.allowedDirectories);
    args[0] = directory;
  }
  if (includes(PROJECT_GIT_INTEGRATION)) {
    const mapPath = async (value: string): Promise<string> => {
      const requested = await canonical(projectGitLocation(value)?.path ?? value);
      if (contains(logicalRoot, requested)) return path.resolve(directory, path.relative(logicalRoot, requested));
      if (selection.mode === 'native_workspace' && contains(directory, requested)) return requested;
      await assertResourcePathAllowed(requested, principal.allowedDirectories);
      const [original, linked] = await Promise.all([resolvePrimaryWorktreeRoot(directory), resolvePrimaryWorktreeRoot(requested)]);
      if (!samePath(await canonical(original.root), await canonical(linked.root))) throw new Error('Integration directory belongs to another project');
      return requested;
    };
    const normalize = async (value: unknown, key = ''): Promise<unknown> => {
      if (typeof value === 'string' && ['repoRoot', 'tempWorktreePath', 'cleanTargetWorktrees'].includes(key)) return mapPath(value);
      if (Array.isArray(value)) return Promise.all(value.map(item => normalize(item, key)));
      if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await normalize(item, name)])));
      return value;
    };
    for (let i = 0; i < args.length; i++) args[i] = typeof args[i] === 'string' ? await mapPath(args[i] as string) : await normalize(args[i]);
  }
  if (command.operation === 'cloneRepository') {
    const input = args[0] as { destinationPath?: string };
    if (!input || typeof input.destinationPath !== 'string') throw new Error('Clone destination is required');
    await assertResourcePathAllowed(input.destinationPath, principal.allowedDirectories);
  }
  if (['deleteGitWorktree', 'createGitWorktree', 'previewGitWorktree', 'validateGitWorktree'].includes(command.operation)) {
    const input = args[1] as { directory?: string } | undefined;
    if (input?.directory) await assertResourcePathAllowed(input.directory, principal.allowedDirectories);
  }
  if (command.operation === 'validateWorktreeDirectory') {
    if (typeof args[1] !== 'string') throw new Error('Worktree root is required');
    await assertResourcePathAllowed(args[1], principal.allowedDirectories);
  }
  signal?.throwIfAborted();
  const result = await options.dispatch({ ...command, args } as ProjectGitCommand, signal);
  // A mounted execution path is not the project's navigation/Documents root.
  // Keep discovery in the original logical space so nested IDE repositories can
  // retain this frozen adoption without treating its private mount as a project.
  if (selection.mode === 'native_workspace' && ['resolveGitPrimaryRoot', 'resolveGitTopLevel'].includes(command.operation)
    && result && typeof result === 'object' && 'root' in result && typeof result.root === 'string'
    && contains(executionRoot, result.root)) {
    return { ...result, root: path.resolve(logicalRoot, path.relative(executionRoot, result.root)) };
  }
  return result;
}

export async function dispatchProjectGitHub(options: { dispatch: ProjectGitDispatcher; nativeWorkspaces?: Pick<NativeWorkspaceOwner, 'prepareSelection'> },
  principal: ManagedSourcePrincipal, workspaceId: string, registeredRoot: string, command: import('@varin/application-client').ProjectGitHubCommand, signal?: AbortSignal): Promise<unknown> {
  if (!command || typeof command.operation !== 'string' || !Array.isArray(command.args)) throw new Error('Invalid project GitHub command');
  const require = (...capabilities: string[]) => { for (const capability of capabilities) if (!principal.capabilities.includes(capability)) throw new Error(`Target GitHub requires ${capability}`); };
  require('filesystem:read', 'terminal:use');
  if (command.operation.startsWith('auth') || command.operation === 'me' || command.operation === 'repoBranches') require('config:read');
  if (command.operation.startsWith('auth') && command.operation !== 'authStatus') require('config:write');
  if (['prCreate','prUpdate','prMerge','prReady','authSyncTerminal','authConfigureGitAuthor'].includes(command.operation)) require('process:control');
  await assertResourcePathAllowed(registeredRoot, principal.allowedDirectories);
  const args: unknown[] = structuredClone(command.args);
  const directoryMethods = ['prStatus','repoUpstream','prsList','prContext','issuesList','issueGet','issueComments'];
  const payloadMethods = ['prCreate','prUpdate','prMerge','prReady'];
  if (directoryMethods.includes(command.operation) || payloadMethods.includes(command.operation)) {
    const payload = args[0] as { directory?: string };
    const directory = directoryMethods.includes(command.operation) ? args[0] : payload?.directory;
    if (typeof directory !== 'string') throw new Error('Original GitHub project directory is required');
    let resolved = registeredRoot;
    await dispatchProjectGit({ ...options, dispatch: async normalized => { resolved = normalized.args[0] as string; } }, principal, workspaceId, registeredRoot,
      { operation: 'getGitStatus', args: [directory], selection: command.selection }, signal);
    if (directoryMethods.includes(command.operation)) args[0] = resolved;
    else args[0] = { ...payload, directory: resolved };
  }
  signal?.throwIfAborted();
  return options.dispatch({ ...command, args } as import('@varin/application-client').ProjectGitHubCommand, signal);
}
