/** Original local resource owners. Neither construction starts an Agent, opens its Catalog,
 * or requires a model. Admission still runs through Documents and the private kernel. */
import type { DocumentAuthority } from '../documents/authority.js';
import { createKernelComputeService } from './compute-service.js';
import { KernelFileResourceBackend } from './file-resource-backend.js';
import type { KernelClient } from './kernel-client.js';
import { KernelRecoveryContentStore, KernelRecoveryStore } from './kernel-recovery-store.js';
import { createKernelProcessIdentityResolver } from './process-identity.js';
import { createKernelProcessService } from './process-service.js';
import { KernelStorageAdapter } from './storage-adapter.js';

export function createHostResourceStorage(input: {
  kernel: KernelClient;
  // Documents itself consumes Storage. Resolve registrations only at operation time.
  documents(): Pick<DocumentAuthority, 'resolveWorkspace' | 'getWorkspace'>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string>;
}) {
  const identity = input.kernel.handshake;
  if (!identity) throw new Error('Resource storage requires a handshaken kernel');
  const recoveryCoordinatorWorkspace = `recovery-coordinator:${identity.hostId}`;
  const kernelStorageAdapter = new KernelStorageAdapter({
    client: input.kernel, hostId: identity.hostId, storageRoot: identity.storageRoot,
    recoveryCoordinatorWorkspace, resolveWorkspaceRoot: input.resolveWorkspaceRoot,
  });
  const resolveExecutionRoot = async (canonicalRoot: string) => {
    const documents = input.documents();
    const { workspaceId } = await documents.resolveWorkspace({ path: canonicalRoot });
    return { workspaceId, canonicalRoot: (await documents.getWorkspace(workspaceId)).root };
  };
  kernelStorageAdapter.bindFileRootResolver(resolveExecutionRoot);
  const kernelFileResources = new KernelFileResourceBackend(kernelStorageAdapter, { resolveExecutionRoot });
  const kernelRecoveryFileResources = new KernelFileResourceBackend(kernelStorageAdapter, {
    resolveExecutionRoot, authorityPurpose: 'recovery-maintenance', authorityCapabilities: ['recovery.maintenance'],
  });
  const kernelRecoveryContentStore = new KernelRecoveryContentStore(kernelStorageAdapter, kernelRecoveryFileResources);
  kernelStorageAdapter.bindFileStore(kernelRecoveryContentStore);
  kernelStorageAdapter.bindFileResources(kernelFileResources);
  const kernelRecoveryStore = new KernelRecoveryStore(kernelStorageAdapter, kernelRecoveryContentStore);
  return { kernelStorageAdapter, kernelFileResources, kernelRecoveryFileResources, kernelRecoveryContentStore,
    kernelRecoveryStore, recoveryCoordinatorWorkspace };
}

export function createHostResourceExecution(client: KernelClient,
  documents: Parameters<typeof createKernelProcessIdentityResolver>[0]['documents'], onError: (error: Error) => void) {
  const resolveIdentity = createKernelProcessIdentityResolver({ documents });
  return {
    kernelProcesses: createKernelProcessService({ client, resolveIdentity, onError }),
    kernelCompute: createKernelComputeService({ client, resolveIdentity }),
  };
}
