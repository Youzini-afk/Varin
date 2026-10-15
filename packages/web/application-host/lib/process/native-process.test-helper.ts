import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentAuthority, type DocumentAuthority } from "../documents/authority.js";
import { createKernelClient } from "../kernel/kernel-client.js";
import { KernelStorageAdapter } from "../kernel/storage-adapter.js";
import { KernelFileResourceBackend } from "../kernel/file-resource-backend.js";
import { KernelRecoveryContentStore, KernelRecoveryStore } from "../kernel/kernel-recovery-store.js";
import { createKernelProcessService } from "../kernel/process-service.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
export const hasNativeProcessKernel = fs.existsSync(kernelPath);

/** An isolated real-kernel fixture. No Node/Bun PTY production fallback. */
export function createNativeProcessTestHarness(authority?: DocumentAuthority) {
  let initialized: Promise<{
    service: ReturnType<typeof createKernelProcessService>;
    client: ReturnType<typeof createKernelClient>;
    documents: ReturnType<typeof createDocumentAuthority>;
    root: string;
    adapter: KernelStorageAdapter;
  }> | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const release of cleanups.splice(0).reverse()) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Native process fixture cleanup failed');
  };
  const get = () => initialized ??= (async () => {
    if (!hasNativeProcessKernel) throw new Error("Native process fixture needs bun run kernel:build");
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "varin-process-consumer-"));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const buildVersion = (JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { version: string }).version;
      const client = createKernelClient({ hostId: "process-consumer", storageRoot: path.join(root, "storage"), kernelPath, buildVersion, allowCargoDevRunner: false });
      cleanups.push(() => client.close());
      const documents = authority ?? createDocumentAuthority({ hostId: "process-consumer", dataDir: path.join(root, "documents"), isAllowedRoot: async () => true, isTrusted: async () => true });
      if (!authority) cleanups.splice(cleanups.length - 1, 0, () => documents.dispose());
      await client.start();
      const adapter = new KernelStorageAdapter({
        client, hostId: "process-consumer", storageRoot: path.join(root, "storage"),
        resolveWorkspaceRoot: async (workspaceId) => (await documents.inspectWorkspace(workspaceId)).root,
      });
      cleanups.push(() => adapter.dispose());
      const backend = new KernelFileResourceBackend(adapter, {
        authorityPurpose: "recovery-maintenance", authorityCapabilities: ["recovery.maintenance"],
        resolveExecutionRoot: async (directory) => {
          const { workspaceId } = await documents.resolveWorkspace({ path: directory });
          return { workspaceId, canonicalRoot: (await documents.inspectWorkspace(workspaceId)).root };
        },
      });
      const content = new KernelRecoveryContentStore(adapter, backend);
      adapter.bindFileStore(content);
      const recovery = new KernelRecoveryStore(adapter, content);
      documents.bindDurableMutationStorage(async (workspaceId, operation) => operation(await recovery.workspaceStorageContext(workspaceId)));
      const service = createKernelProcessService({
        client,
        resolveIdentity: async (cwd) => {
          const identity = await documents.resolveWorkspace({ path: cwd });
          const inspected = await documents.inspectWorkspace(identity.workspaceId);
          return { workspaceId: identity.workspaceId, executionWorkspaceId: identity.workspaceId, canonicalRoot: inspected.root };
        },
      });
      cleanups.push(() => service.dispose());
      return { service, client, documents, root, adapter };
    } catch (error) {
      try { await cleanup(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native process fixture initialization failed');
      }
      throw error;
    }
  })();
  return {
    get,
    async loadPtyProvider() { return (await get()).service.ptyProvider; },
    async dispose(): Promise<void> {
      if (!initialized) return;
      // A rejected initializer already rolled back everything it acquired.
      try { await initialized; } catch { return; }
      await cleanup();
    },
  };
}
