#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Runs emitted Host JavaScript and a manifest-verified release kernel from an
 * unrelated working directory. No source loader, Cargo, model call or user data. */
export async function smokeKernelRelease({ webRoot, kernelDirectory = path.join(webRoot, 'kernel') }) {
  webRoot = path.resolve(webRoot);
  const executable = process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel';
  const manifest = JSON.parse(await fs.readFile(path.join(kernelDirectory, 'manifest.json'), 'utf8'));
  const version = JSON.parse(await fs.readFile(path.join(webRoot, 'package.json'), 'utf8')).version;
  assert.equal(manifest.buildIdentity, version);
  const importHost = (file) => import(pathToFileURL(path.join(webRoot, 'server', file)).href);
  const { createKernelClient } = await importHost('lib/kernel/kernel-client.js');
  const { runKernelCompute } = await importHost('lib/kernel/compute-runner.js');
  const { createKernelProcessService } = await importHost('lib/kernel/process-service.js');
  const { createKernelComputeService } = await importHost('lib/kernel/compute-service.js');
  const { createTreeSitterStructureProvider } = await importHost('lib/structure/tree-sitter-provider.js');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-release-'));
  const workspace = path.join(temporary, 'workspace with spaces');
  const unrelated = path.join(temporary, 'unrelated cwd');
  await fs.mkdir(workspace); await fs.mkdir(unrelated);
  const source = 'export function releaseNeedle() { return "fixed-release-body"; }\n';
  await fs.writeFile(path.join(workspace, 'note.ts'), source);
  let pinId;
  let fixedRoot;
  let observation;
  const open = (directory) => createKernelClient({
    hostId: 'release-acceptance', storageRoot: path.join(temporary, 'data/kernel/release-acceptance'),
    kernelPath: path.join(directory, executable), buildVersion: version, cwd: unrelated,
    allowCargoDevRunner: false, requireKernelManifest: true,
  });
  try {
    const host = open(kernelDirectory);
    const processes = createKernelProcessService({ client: host, resolveIdentity: async () => ({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: workspace }) });
    const compute = createKernelComputeService({ client: host, resolveIdentity: async () => ({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: workspace }) });
    try {
      const handshake = await host.start();
      assert.equal(handshake.kernelBuildIdentity, version);
      const client = host.scoped(await host.issueGrant({ grantId: 'release-owner', owningWorkspace: 'ws', executionWorkspace: 'ws', pathScopes: [''], capabilities: ['storage.read', 'storage.write', 'storage.gc'] }));
      const root = await client.fileRootRegister({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: workspace });
      const object = await client.putBlob(Buffer.from(source), 'release-source');
      await client.createBranch({ operationId: 'release-branch', branchId: 'release-branch', workspaceId: 'ws', entries: [{ path: 'note.ts', ownerId: object.ownerId, state: { kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 } }], draftBasePaths: [], captureScopes: [] });
      const pin = await client.pinBranch({ operationId: 'release-pin', branchId: 'release-branch', revision: 0 });
      pinId = String(pin.pinId); fixedRoot = String(pin.root);
      const before = await client.fileCapture({ workspaceId: 'ws', rootId: root.rootId, operationId: 'release-before', path: 'note.ts', store: false });
      const changed = await client.putBlob(Buffer.from('export const changed = "live disk";\n'), 'release-after');
      const applied = await client.fileApply({ workspaceId: 'ws', rootId: root.rootId, operationId: 'release-apply', path: 'note.ts', expectedJson: String(before.stateJson), targetJson: JSON.stringify({ kind: 'regular-file', objectHash: changed.hash, byteLength: changed.byteLength, mode: JSON.parse(String(before.stateJson)).mode }), ownerId: changed.ownerId });
      assert.equal(applied.status, 'applied');
      assert.equal(await fs.readFile(path.join(workspace, 'note.ts'), 'utf8'), 'export const changed = "live disk";\n');

      const found = await runKernelCompute(client, { workspaceId: 'ws', pinId, lane: 'foreground', operation: 'search', query: 'fixed-release-body', fixedStrings: true });
      assert.equal(found.root, fixedRoot);
      assert.equal(found.status, 'ready');
      assert.equal(found.records.filter(record => record.kind === 'hit').length, 1);
      const provider = createTreeSitterStructureProvider({ compute, runtimeFromUrl: pathToFileURL(path.join(webRoot, 'server/lib/structure/tree-sitter-provider.js')).href, parseBudgetMs: 10_000 });
      const units = await provider.unitsFixed({ workspaceId: 'ws', path: 'note.ts', languageId: 'typescript', compute: (input, options) => runKernelCompute(client, { ...input, workspaceId: 'ws', pinId }, options) });
      assert.equal(units.status, 'ready', JSON.stringify(units));
      assert.ok(units.units.some(unit => unit.text.includes('fixed-release-body')));
      const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'echo native-release-shell & exit /b 7'] : ['-c', 'printf native-release-shell; exit 7'];
      const child = await processes.spawn(command, args, { cwd: workspace, env: process.env });
      let output = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; }); child.stderr.resume();
      await child.completion;
      assert.equal(child.exitCode, 7);
      assert.match(output, /native-release-shell/);
      assert.ok((await processes.list(workspace)).every(process => !process.writerActive));
      const health = await client.health({ deep: true });
      assert.equal(health.integrity, 'ok');
      observation = { kernelEpoch: handshake.kernelEpoch, fixedRoot, structureRevision: units.revision, shellExitCode: child.exitCode, integrity: health.integrity };
    } finally {
      try { await compute.dispose(); } finally {
        try { await processes.dispose(); } finally { await host.close(); }
      }
    }
    const corrupted = path.join(temporary, 'invalid manifest');
    await fs.mkdir(corrupted);
    await fs.copyFile(path.join(kernelDirectory, executable), path.join(corrupted, executable));
    await fs.writeFile(path.join(corrupted, 'manifest.json'), JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    const invalid = open(corrupted);
    try { await assert.rejects(invalid.start(), /manifest.*match/i); } finally { await invalid.close(); }
    return { schema: 1, platform: process.platform, arch: process.arch, node: process.version, buildIdentity: version, kernelSha256: createHash('sha256').update(await fs.readFile(path.join(kernelDirectory, executable))).digest('hex'), arbitraryCwd: true, manifestMismatchRejected: true, observation };
  } finally {
    // On Windows this also proves native handles no longer hold our directory.
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const webRoot = path.resolve(process.argv[2] ?? 'packages/web');
  const kernelDirectory = process.argv[3] ? path.resolve(process.argv[3]) : path.join(webRoot, 'kernel');
  const report = await smokeKernelRelease({ webRoot, kernelDirectory });
  console.log(JSON.stringify({ ...report, cleanupComplete: true }, null, 2));
}
