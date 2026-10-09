import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentAuthority } from "../documents/authority.js";
import { createWorkspaceRecoveryEngine } from "../recovery/journal-engine.js";
import { createKernelClient } from "./kernel-client.js";
import { KernelFileResourceBackend } from "./file-resource-backend.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "./kernel-recovery-store.js";
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from "./storage-adapter.js";

/** Real R1/R2/R3 assembly for cross-domain acceptance. No local writer fallback. */
export async function createAuthorityTestRuntime(options: {
  documents: DocumentAuthority;
  hostId: string;
  dataDir: string;
  sessionNavigation?: Parameters<typeof createWorkspaceRecoveryEngine>[0]["sessionNavigation"];
}) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
  await fs.access(kernelPath);
  const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
  const storageRoot = path.join(options.dataDir, "kernel", options.hostId);
  const client = createKernelClient({ hostId: options.hostId, storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  await client.start();
  const adapter = new KernelStorageAdapter({
    client, hostId: options.hostId, storageRoot,
    resolveWorkspaceRoot: async (workspaceId) => (await options.documents.inspectWorkspace(workspaceId)).root,
  });
  adapter.bindFileRootResolver(async (directory) => {
    const { workspaceId } = await options.documents.resolveWorkspace({ path: directory });
    return { workspaceId, canonicalRoot: (await options.documents.inspectWorkspace(workspaceId)).root };
  });
  const backend = new KernelFileResourceBackend(adapter, {
    authorityPurpose: "recovery-maintenance", authorityCapabilities: ["recovery.maintenance"],
    resolveExecutionRoot: async (directory) => {
      const { workspaceId } = await options.documents.resolveWorkspace({ path: directory });
      return { workspaceId, canonicalRoot: (await options.documents.inspectWorkspace(workspaceId)).root };
    },
  });
  adapter.bindFileResources(backend);
  const content = new KernelRecoveryContentStore(adapter, backend);
  adapter.bindFileStore(content);
  const recovery = new KernelRecoveryStore(adapter, content);
  const base = createWorkspaceRecoveryEngine({
    authorityId: options.hostId, dataDir: options.dataDir, documents: options.documents,
    durableRecoveryStore: recovery, fileStore: content,
    sessionNavigation: options.sessionNavigation ?? {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null, removedEntryIds: [] }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}), commitLeaf: async () => ({}),
    },
  });
  const engine = createKernelRecoveryDirectFacade(base, recovery);
  const workingStates = createKernelWorkspaceWorkingStateAccess(adapter, engine, recovery);
  options.documents.bindDurableMutationStorage((id, operation) => engine.withWorkspaceStorage(
    id, { mode: "exclusive", purpose: "document-mutation", create: true }, operation,
  ));
  return {
    client, adapter, backend, content, recovery, engine, workingStates, storageRoot,
    async dispose() {
      options.documents.bindDurableMutationStorage(null);
      try { await engine.dispose(); } finally {
        try { await adapter.dispose(); } finally { await client.close(); }
      }
    },
  };
}
