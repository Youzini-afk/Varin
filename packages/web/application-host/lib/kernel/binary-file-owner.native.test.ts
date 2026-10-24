import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { writeSourceBinary, type BinaryFileWrite } from './binary-file-owner.js';
import type { LaunchSource, RecoveryAnchor } from './protocol.generated.js';
import type { OfficeCreateContent } from '@varin/protocol';
import { createOfficeFile } from '../office/create.js';
import { OfficePackage } from '../office/package.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const noImage = async (): Promise<Buffer> => { throw new Error('No image was requested'); };

async function fixture() {
  await fs.access(kernelPath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-binary-owner-'));
  const workspace = path.join(directory, 'work');
  await fs.mkdir(workspace);
  const host = createKernelClient({ hostId: 'binary-host', storageRoot: path.join(directory, 'store'), kernelPath, buildVersion, allowCargoDevRunner: false });
  cleanups.push(async () => { await host.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await host.start();
  // The writer runs under the original Run grant, which owns the recovery journal anchor.
  const client = host.scoped(await host.issueGrant({ grantId: 'office-writer', threadId: 'thread', runId: 'run',
    owningWorkspace: 'workspace', executionWorkspace: 'workspace', pathScopes: [''], capabilities: ['storage.read', 'storage.write'] }));
  const registered = await client.fileRootRegister({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: workspace });
  const rootId = String(registered.rootId);
  const source: LaunchSource = { workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: null, revision: null, mode: 'live_root',
    live_root: { hostId: 'binary-host', rootId, canonicalRoot: String(registered.canonicalRoot) }, resource_owner: { kind: 'local' } };
  const journal: RecoveryAnchor = { executionId: 'turn', threadId: 'thread', branchId: 'branch', runId: 'run', entryId: 'input', epoch: 1 };
  const write = (operationId: string, input: BinaryFileWrite) => writeSourceBinary({ ...input, client, rootId, source, operationId, tool: 'office_write', journal });
  return { client, rootId, workspace, write };
}

it.each<Array<['docx' | 'xlsx', OfficeCreateContent]>[number]>([
  ['docx', { format: 'docx', blocks: [{ kind: 'paragraph', text: 'Quarterly report' }] }],
  ['xlsx', { format: 'xlsx', sheets: [{ name: 'Data', rows: [['Value', 'Total'], [2, { formula: 'A2*3' }]] }] }],
])('saves a generated %s package through the native lease, capture and conditional apply chain', async (format, content) => {
  const f = await fixture();
  const file = `report.${format}`;
  const bytes = await createOfficeFile(content, noImage);
  const created = await f.write(`create-${format}`, { path: file, expectedRevision: null, bytes });
  expect(created).toMatchObject({ status: 'applied', path: file, revision: new OfficePackage(bytes).revision, byteLength: bytes.byteLength, executorStopped: true });
  expect(created.cleanupPending).toBeUndefined();
  const saved = new OfficePackage(await fs.readFile(path.join(f.workspace, file)));
  expect(saved).toMatchObject({ format, revision: created.revision });

  // The original operation identity returns its original receipt; it never writes again.
  const other = await createOfficeFile(format === 'docx' ? { format, blocks: [{ kind: 'paragraph', text: 'Replacement' }] }
    : { format, sheets: [{ name: 'Other', rows: [[1]] }] }, noImage);
  expect(await f.write(`create-${format}`, { path: file, expectedRevision: null, bytes: other })).toMatchObject({ status: 'applied', revision: created.revision });
  expect(await f.write(`create-again-${format}`, { path: file, expectedRevision: null, bytes: other })).toMatchObject({ status: 'conflict', revision: created.revision });
  expect(new OfficePackage(await fs.readFile(path.join(f.workspace, file))).revision).toBe(created.revision);

  const objects = saved.read({ view: 'content', ...(format === 'xlsx' ? { section: 'Data', range: 'A2' } : {}) }).objects!;
  const edited = format === 'docx'
    ? saved.edit([{ action: 'replace_text', objectId: objects[0]!.id, oldText: 'Quarterly report', newText: 'Annual report' }])
    : saved.edit([{ action: 'set_cells', sheet: 'Data', start: 'A2', values: [[4]] }]);
  const updated = await f.write(`edit-${format}`, { path: file, expectedRevision: created.revision!, bytes: edited.bytes });
  expect(updated).toMatchObject({ status: 'applied', revision: new OfficePackage(edited.bytes).revision });
  const reread = new OfficePackage(await fs.readFile(path.join(f.workspace, file)));
  expect(reread.revision).toBe(updated.revision);
  if (format === 'docx') expect(reread.read({ view: 'content' }).objects?.[0]?.text).toBe('Annual report');
  else expect(reread.read({ section: 'Data', range: 'A2' }).objects?.[0]).toMatchObject({ value: 4 });

  // A stale revision is a conflict and keeps the current document.
  expect(await f.write(`stale-${format}`, { path: file, expectedRevision: created.revision!, bytes: other })).toMatchObject({ status: 'conflict', revision: updated.revision });
  expect(new OfficePackage(await fs.readFile(path.join(f.workspace, file))).revision).toBe(updated.revision);
  // Every write released its exact lease.
  expect(await f.client.fileLeaseAcquire({ workspaceId: 'workspace', rootId: f.rootId, leaseId: 'after-writes', resources: [{ path: file, scope: 'exact' }] }))
    .toMatchObject({ status: 'acquired' });
}, 30_000);
