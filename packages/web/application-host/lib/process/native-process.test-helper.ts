import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
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

export interface NativeProcessDiagnostic {
  processId: string;
  guardianPid: number;
  elapsedMs: number;
  stage: string;
}

function observeProcessDiagnostics(child: ChildProcess, observe: (event: NativeProcessDiagnostic) => void): void {
  const prefix = '[native process stage] ';
  // This is only a diagnostic carry limit, not a process-output/protocol limit.
  // Never retain an unbounded unrelated stderr line while waiting for a newline.
  const maxLine = 8 * 1024;
  let pending = '';
  let discarding = false;
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const parts = chunk.toString().split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      if (!discarding) pending += parts[index];
      if (pending.length > maxLine) { pending = ''; discarding = true; }
      if (index === parts.length - 1) break;
      if (!discarding && pending.startsWith(prefix)) {
        try {
          const value = JSON.parse(pending.slice(prefix.length)) as Partial<NativeProcessDiagnostic> | null;
          if (value && typeof value.processId === 'string' && value.processId.length > 0
            && Number.isSafeInteger(value.guardianPid) && value.guardianPid! > 0
            && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs! >= 0
            && typeof value.stage === 'string' && /^[a-z][a-z0-9-]*$/.test(value.stage)) {
            // Only the kernel's static stage metadata is forwarded. Unrelated
            // stderr, extra JSON properties and observer failures are ignored.
            observe({ processId: value.processId, guardianPid: value.guardianPid!, elapsedMs: value.elapsedMs!, stage: value.stage });
          }
        } catch { /* Diagnostic observation cannot change process completion. */ }
      }
      pending = ''; discarding = false;
    }
  });
}

/** An isolated real-kernel fixture. No Node/Bun PTY production fallback. */
export function createNativeProcessTestHarness(authority?: DocumentAuthority, options: {
  hostId?: string;
  onProcessDiagnostic?: (event: NativeProcessDiagnostic) => void;
} = {}) {
  let initialized: Promise<{
    service: ReturnType<typeof createKernelProcessService>;
    client: ReturnType<typeof createKernelClient>;
    documents: ReturnType<typeof createDocumentAuthority>;
    root: string;
    adapter: KernelStorageAdapter;
    backend: KernelFileResourceBackend;
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
      const observeDiagnostic = options.onProcessDiagnostic;
      const client = createKernelClient({ hostId: options.hostId ?? "process-consumer", storageRoot: path.join(root, "storage"), kernelPath, buildVersion, allowCargoDevRunner: false,
        ...(observeDiagnostic ? {
          env: { VARIN_PROCESS_TRACE: '1' },
          spawnProcess: ((command: string, args: string[], spawnOptions: Parameters<typeof nodeSpawn>[2]) => {
            const child = nodeSpawn(command, args, spawnOptions);
            observeProcessDiagnostics(child, observeDiagnostic);
            return child;
          }) as typeof nodeSpawn,
        } : {}),
      });
      cleanups.push(() => client.close());
      const documents = authority ?? createDocumentAuthority({ hostId: options.hostId ?? "process-consumer", dataDir: path.join(root, "documents"), isAllowedRoot: async () => true, isTrusted: async () => true });
      // Documents owns native watches and may still use the original storage
      // during disposal. Register its storage cleanup below it, never above it.
      const storageCleanupIndex = cleanups.length;
      if (!authority) cleanups.push(() => documents.dispose());
      await client.start();
      const adapter = new KernelStorageAdapter({
        client, hostId: options.hostId ?? "process-consumer", storageRoot: path.join(root, "storage"),
        resolveWorkspaceRoot: async (workspaceId) => (await documents.inspectWorkspace(workspaceId)).root,
      });
      cleanups.splice(storageCleanupIndex, 0, () => adapter.dispose());
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
      return { service, client, documents, root, adapter, backend };
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
