import path from 'node:path';
import { createThreadResourceScope, type ThreadResourceScopeOwners } from './thread-resource-scope.js';

/** Native fixtures use the real source/resource admission with isolated, absent user roots. */
export function resourceScopeFixture(root: string, workingStates: ThreadResourceScopeOwners['workingStates'],
  documents?: ThreadResourceScopeOwners['documents'], validateLiveSource?: ThreadResourceScopeOwners['validateLiveSource']) {
  return createThreadResourceScope({ agentDir: path.join(root, 'resource-agent'), homeDir: path.join(root, 'resource-home'), workingStates,
    documents: documents ?? { inspectWorkspace: async () => { throw new Error('This fixture admits no workspace'); },
      readSnapshot: async () => { throw new Error('This fixture admits no Documents read'); } },
    validateLiveSource: validateLiveSource ?? (async () => { throw new Error('This fixture admits no live source'); }),
    projectTrusted: async () => false, configuration: async () => ({ packages: [] }) });
}
