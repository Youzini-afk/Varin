import path from 'node:path';
import { createThreadResourceScope, type ThreadResourceScopeOwners } from './thread-resource-scope.js';

/** Native fixtures use the real source/resource admission with isolated, absent user roots. */
export function resourceScopeFixture(root: string, workingStates: ThreadResourceScopeOwners['workingStates'],
  documents?: ThreadResourceScopeOwners['documents'], validateLiveSource?: ThreadResourceScopeOwners['validateLiveSource'],
  withSourceRead?: ThreadResourceScopeOwners['withSourceRead'],
  resolveNativeSource?: ThreadResourceScopeOwners['resolveNativeSource']) {
  return createThreadResourceScope({ dataDirectory: path.join(root, 'resource-agent'), homeDir: path.join(root, 'resource-home'), workingStates,
    documents: documents ?? { admitWorkspaceRegistration: async () => { throw new Error('This fixture admits no workspace'); }, inspectWorkspace: async () => { throw new Error('This fixture admits no workspace'); },
      readSnapshot: async () => { throw new Error('This fixture admits no Documents read'); } },
    validateLiveSource: validateLiveSource ?? (async () => { throw new Error('This fixture admits no live source'); }),
    withSourceRead: withSourceRead ?? (async () => { throw new Error('This fixture admits no fixed source reader'); }),
    ...(resolveNativeSource ? { resolveNativeSource } : {}),
    projectTrusted: async () => false, configuration: async () => ({ packages: [] }) });
}
