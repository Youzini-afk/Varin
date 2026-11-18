/** Standalone managed live-directory node. No Agent, UI backend, extension activation or outbound connections. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { ExtensionCatalogStore } from '@varin/extension-host';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { assertDataRootMayStart } from './lib/data-restore-guard.js';
import { createDocumentRootGuard } from './lib/documents/allowed-roots.js';
import { createDocumentAuthority } from './lib/documents/authority.js';
import { bindDocumentTextCodec } from './lib/documents/inspect.js';
import { createManagedResourceTarget } from './lib/harness/managed-resource-target.js';
import { createResourceFilesOwner } from './lib/workspace/resource-files.js';
import { createHostResourceStorage, createHostResourceExecution } from './lib/kernel/host-resource-owners.js';
import { createKernelClient } from './lib/kernel/kernel-client.js';
import { createLiveSourceOwner } from './lib/kernel/live-source.js';
import { SourceAdmissionError } from './lib/kernel/source-admission-error.js';
import { createPrincipalStore } from './lib/ui-auth/principals.js';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './lib/workspace/path-safety.js';

interface NodeDirectories { dataDir: string; workspaceRoot: string; kernelPath?: string }
interface NodeOptions extends NodeDirectories { host?: string; port?: number; releaseId?: string }

const requiredAbsolute = (value: string | undefined, name: string) => {
  if (!value || !path.isAbsolute(value)) throw new Error(name + ' must be an explicit absolute path');
  return value;
};
async function directories(options: NodeDirectories) {
  const workspaceRoot = await canonicalizePathIdentity(requiredAbsolute(options.workspaceRoot, 'VARIN_WORKSPACE_ROOT'));
  if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error('Shared workspace must be a directory');
  const requested = requiredAbsolute(options.dataDir, 'VARIN_DATA_DIR');
  // Never expose the auth store or the kernel data root as a resource, including through an alias.
  const dataDir = await canonicalizePathIdentity(requested, { allowMissing: true });
  if (isPathWithinRoot(dataDir, workspaceRoot) || isPathWithinRoot(workspaceRoot, dataDir)) {
    throw new Error('Node state and the shared workspace must be disjoint directories');
  }
  await assertDataRootMayStart(dataDir);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  return { dataDir, workspaceRoot };
}
async function createNodeKernel(dataDir: string, kernelPath?: string) {
  // Both roles use the same durable identity. Native Storage owns its exclusive writer lock;
  // an offline admin command must not mutate a credential index cached by another live process.
  const { hostId } = await new ExtensionCatalogStore(dataDir).getHostIdentity();
  const version: unknown = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new Error('Missing Varin build version');
  const kernel = createKernelClient({ role: 'resources', hostId, storageRoot: path.join(dataDir, 'kernel', hostId),
    buildVersion: version, kernelBuildIdentity: version, allowCargoDevRunner: false, ...(kernelPath ? { kernelPath } : {}) });
  return { hostId, kernel, version };
}
async function offlineAdmin<T>(dataDir: string, kernelPath: string | undefined, work: (clients: ReturnType<typeof openAuth>['clients']) => Promise<T>) {
  const { kernel } = await createNodeKernel(dataDir, kernelPath);
  try {
    await kernel.start();
    const { clients } = openAuth(dataDir);
    try { return await work(clients); } finally { await clients.dispose(); }
  } finally { await kernel.close(); }
}
function openAuth(dataDir: string) {
  const principals = createPrincipalStore(path.join(dataDir, 'ui-principals.json'));
  const clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path,
    storePath: path.join(dataDir, 'remote-clients.json'), principals });
  return { clients, principals };
}

// Local admin only. No HTTP bootstrap route, wildcard grant or bearer in normal output.
export async function pairResourceNode(options: NodeDirectories & { output: string; write?: boolean; commands?: boolean }) {
  const { dataDir, workspaceRoot } = await directories(options);
  const output = await canonicalizePathIdentity(requiredAbsolute(options.output, '--output'), { allowMissing: true });
  if (isPathWithinRoot(output, workspaceRoot) || isPathWithinRoot(output, dataDir))
    throw new Error('Store the new credential in a private file outside the shared workspace and node state directory');
  return offlineAdmin(dataDir, options.kernelPath, async clients => {
    let id: string | undefined;
    const file = await fs.open(output, 'wx', 0o600);
    let rolledBack = false;
    const created = await file.stat({ bigint: true });
    try {
      const entry = await clients.createClient({ label: 'Resource node coordinator', allowedDirectories: [workspaceRoot],
        capabilities: ['filesystem:read', ...(options.write ? ['filesystem:write'] : []),
          ...(options.commands ? ['terminal:use', 'process:control', 'logs:read'] : [])] });
      id = entry.client.id;
      await file.writeFile(JSON.stringify({ clientId: id, token: entry.token }) + '\n');
      await file.sync();
    } catch (error) {
      if (id) await clients.revokeClient(id);
      rolledBack = true;
      throw error;
    } finally {
      await file.close();
      if (rolledBack) {
        const current = await fs.lstat(output, { bigint: true }).catch(() => undefined);
        if (current?.dev === created.dev && current.ino === created.ino) await fs.unlink(output);
      }
    }
    return id;
  });
}

export async function revokeResourceNodeClient(options: NodeDirectories, clientId: string) {
  if (!clientId?.trim()) throw new Error('A client ID is required');
  const { dataDir } = await directories(options);
  await offlineAdmin(dataDir, options.kernelPath, async clients => {
    if (!(await clients.revokeClient(clientId)).revoked) throw new Error('Unknown client ID');
  });
}

export async function startResourceNode(options: NodeOptions) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid node port');
  const { dataDir, workspaceRoot } = await directories(options);
  const { kernel, version, hostId } = await createNodeKernel(dataDir, options.kernelPath);
  const cleanup: (() => Promise<unknown> | void)[] = [];
  let closing: Promise<void> | undefined;
  let draining = false;
  const close = () => {
    draining = true;
    return closing ??= (async () => {
      const errors = [];
      for (const stop of cleanup.splice(0).reverse()) try { await stop(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Resource node shutdown incomplete');
    })();
  };
  try {
    cleanup.push(() => kernel.close());
    await kernel.start();
    const { clients, principals } = openAuth(dataDir);
    cleanup.push(() => clients.dispose());
    const auth = createUiAuth({ principals, dataDir, requireClientAuth: true, clientAuthController: clients,
      getServerId: async () => hostId });
    cleanup.push(auth.dispose, bindDocumentTextCodec(kernel));
    const deployment = createDocumentRootGuard({ workspace: { root: workspaceRoot, lockdown: true }, fsPromises: fs, pathModule: path });
    // A replaced root alias may go offline, but cannot retarget this running node to another directory.
    const guard = async (root: string) => isPathWithinRoot(root, workspaceRoot) && await deployment(root);
    const documents = createDocumentAuthority({ hostId, dataDir, isAllowedRoot: guard, isTrusted: guard });
    cleanup.push(() => documents.dispose());
    const storage = createHostResourceStorage({ kernel, documents: () => documents,
      resolveWorkspaceRoot: async id => (await documents.admitWorkspaceRegistration(id)).canonicalPath });
    cleanup.push(() => storage.kernelStorageAdapter.dispose());
    documents.bindDurableMutationStorage(async (id, work) => work(await storage.kernelRecoveryStore.workspaceStorageContext(id)));
    const execution = createHostResourceExecution(kernel, documents, () => console.error('[ResourceNode] Native process observation unavailable'));
    cleanup.push(() => execution.kernelProcesses.dispose(), () => execution.kernelCompute.dispose());
    const liveSources = createLiveSourceOwner({ documents, kernel });
    const target = createManagedResourceTarget({ kernel, liveSourceOnly: true, storageAvailable: false,
      onError: () => console.error('[ResourceNode] Managed resource observation unavailable') });
    cleanup.push(() => target.dispose());
    target.attachSources({ documents, deviceFileAccess: false, validateLiveSource: liveSources.validate,
      workspaceFiles: createResourceFilesOwner(documents, storage.kernelRecoveryFileResources),
      async prepareSource(input, signal) {
        if (input.mode !== 'live_root' || input.resourceOwner.kind !== 'local' || input.selection?.mode === 'native_workspace')
          throw new SourceAdmissionError('source_unavailable');
        const { workspaceId, threadId, resourceOwner } = input;
        const liveRoot = await liveSources.prepare(workspaceId, workspaceId, threadId, signal);
        // The paired source owner supplies the caller's actual allowed tools, after local preparation.
        return { path: liveRoot.canonicalRoot, source: { mode: 'live_root', resourceOwner, workspaceId,
          executionWorkspaceId: workspaceId, liveRoot, tools: [] } };
      } });
    const app = express();
    app.disable('x-powered-by');
    const observers = new Set<http.ServerResponse>();
    app.get('/health', (_req, res) => {
      const ready = !draining && Boolean(kernel.handshake);
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', role: 'resources',
        releaseId: options.releaseId ?? version });
    });
    app.use((req, res, next) => {
      if (draining) { res.status(503).json({ code: 'host-draining' }); return; }
      if (req.path === '/api/harness/managed-execution/v1/sources/processSubscribe') {
        observers.add(res); res.once('close', () => observers.delete(res));
      }
      next();
    });
    app.use(express.json({ limit: '4mb' }));
    target.mount(app, { documents, requireAuth: auth.requireAuth, resolveAuthContext: auth.resolveAuthContext, isDraining: () => draining });
    // Body parser and middleware failures must not echo request fragments, bearer data or stack traces.
    const fail: express.ErrorRequestHandler = (error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Resource node request failed' });
    };
    app.use(fail);
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      for (const observer of observers) observer.destroy();
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Resource node failed to bind TCP');
    return { hostId, port: address.port, close };
  } catch (error) { await close(); throw error; }
}

async function main(args: string[]) {
  const options = { dataDir: requiredAbsolute(process.env.VARIN_DATA_DIR, 'VARIN_DATA_DIR'),
    workspaceRoot: requiredAbsolute(process.env.VARIN_WORKSPACE_ROOT, 'VARIN_WORKSPACE_ROOT'),
    ...(process.env.VARIN_KERNEL_PATH?.trim() ? { kernelPath: process.env.VARIN_KERNEL_PATH.trim() } : {}) };
  if (args[0] === 'pair' && args[1] === '--output' && args[2] && args.slice(3).every(arg => ['--allow-write', '--allow-commands'].includes(arg))) {
    await pairResourceNode({ ...options, output: args[2], write: args.includes('--allow-write'), commands: args.includes('--allow-commands') });
  } else if (args[0] === 'revoke' && args.length === 2) {
    await revokeResourceNodeClient(options, args[1]!);
  } else if (args.length) {
    throw new Error('Usage: resource-node.js [pair --output /private/client.json [--allow-write] [--allow-commands] | revoke CLIENT_ID]');
  } else {
    const port = process.env.VARIN_PORT === undefined ? 3000 : Number(process.env.VARIN_PORT);
    const node = await startResourceNode({ ...options, host: process.env.VARIN_HOST?.trim() || '127.0.0.1', port,
      ...(process.env.VARIN_RELEASE_ID ? { releaseId: process.env.VARIN_RELEASE_ID } : {}) });
    const close = () => { void node.close().catch(() => { console.error('[ResourceNode] Shutdown incomplete'); process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error('[ResourceNode]', error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; });
}
