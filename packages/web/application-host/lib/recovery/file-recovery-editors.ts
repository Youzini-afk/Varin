import path from 'node:path';
import type { DocumentAuthority } from '../documents/authority.js';
import { canonicalizePathIdentity } from '../workspace/path-safety.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import type { RecoveryIdentity } from './journal-files.js';

export type RecoveryEditors = Pick<DocumentAuthority, 'listWorkspaceRegistrations' | 'beginDirtyStateBarrier' | 'inspectDirtyBuffers'>;

export async function restoreFilesWithEditors(
  documents: RecoveryEditors, files: KernelFileResourceBackend, identity: RecoveryIdentity,
  command: Parameters<KernelFileResourceBackend['recoveryFiles']>[2], signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = command.arguments;
  const inspected = await files.recoveryFiles(identity, 'recovery.points', { ...command, arguments: args.undo
    ? { operation: args.undo } : { point: args.point, ...(args.paths ? { paths: args.paths } : {}) } }, signal);
  const paths = args.undo ? inspected.appliedPaths as string[]
    : (inspected.files as Array<{ path: string }>).map(file => file.path);
  const selected = Array.isArray(args.paths) ? paths.filter(path => (args.paths as string[]).includes(path)) : paths;
  return withFileRecoveryEditors(documents, identity.canonicalRoot, selected, blockedPaths =>
    files.recoveryFiles(identity, 'recovery.files.restore', { ...command, arguments: { ...args, blockedPaths } }, signal));
}

/** Keep live drafts intact while the selected disk files are restored. The same
 * Documents barrier used by combined recovery queues watcher reloads until release. */
export async function withFileRecoveryEditors<T>(
  documents: RecoveryEditors, root: string, paths: string[],
  apply: (blockedPaths: Record<string, string>) => Promise<T>,
): Promise<T> {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const registrations = await documents.listWorkspaceRegistrations();
  const groups = new Map<string, Map<string, string>>();
  for (const resource of paths) {
    const absolute = path.join(await canonicalizePathIdentity(path.dirname(path.join(root, resource)), { allowMissing: true }), path.basename(resource));
    for (const registration of registrations) {
      const relative = path.relative(key(registration.canonicalPath), key(absolute));
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
      const items = groups.get(registration.workspaceId) ?? new Map<string, string>();
      items.set(relative.replaceAll('\\', '/'), resource);
      groups.set(registration.workspaceId, items);
    }
  }
  const held: Awaited<ReturnType<DocumentAuthority['beginDirtyStateBarrier']>>[] = [];
  const blocked: Record<string, string> = {};
  try {
    for (const [workspaceId, resources] of groups) {
      try {
        held.push(await documents.beginDirtyStateBarrier(workspaceId, [...resources.keys()], { caseSensitive: process.platform !== 'win32' }));
        for (const publication of await documents.inspectDirtyBuffers(workspaceId)) {
          for (const entry of publication.resources) {
            const original = resources.get(key(entry.resource.resourceId.replaceAll('\\', '/')));
            if (original) blocked[original] = 'This file has unsaved editor changes. Save or discard the draft before restoring it.';
          }
        }
      } catch (error) {
        for (const original of resources.values()) blocked[original] = error instanceof Error ? error.message : String(error);
      }
    }
    const result = await apply(blocked);
    await Promise.all(held.map(barrier => barrier.settle()));
    return result;
  } finally {
    await Promise.all(held.map(barrier => barrier.release()));
  }
}
