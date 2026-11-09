import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bindDocumentTextCodec } from '../documents/inspect.js';
import { utf8CoordinationCodec } from '../documents/codec.test-helper.js';
import { createAdmittedDirectoryReader, createDocumentResourceReader, createPinnedResourceReader } from './source-reader.js';
import type { WorkingStatePinnedRoot } from '../harness/working-state/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
function codec() {
  const decode = vi.fn(utf8CoordinationCodec.textDecode);
  cleanup.push(bindDocumentTextCodec({ ...utf8CoordinationCodec, textDecode: decode }));
  return decode;
}

it('passes a copied per-file policy for the canonical admitted asset and preserves BOM text', async () => {
  const decode = codec();
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-resource-codec-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), '\ufeff中文\r\n');
  await symlink('AGENTS.md', path.join(root, 'alias.md'));
  const policy = { root, files: { 'AGENTS.md': 'utf-8', 'alias.md': 'gbk' }, defaultEncoding: 'gbk' };
  const reader = await createAdmittedDirectoryReader({ domainId: 'asset', viewId: 'captured', root, textEncoding: policy });
  policy.files['AGENTS.md'] = 'gbk';
  expect(await reader.read('alias.md')).toMatchObject({ status: 'ready', content: '\ufeff中文\r\n' });
  expect(decode).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'utf-8', defaultEncoding: 'gbk' }));
});

it.each(['selected-root', 'ancestor-root', 'unrelated-root'] as const)('keeps %s rules in the canonical namespace of a directory alias', async mode => {
  const decode = codec();
  const base = await mkdtemp(path.join(os.tmpdir(), 'varin-resource-root-alias-'));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const physical = path.join(base, 'physical'), alias = path.join(base, 'alias');
  await mkdir(path.join(physical, 'child'), { recursive: true });
  await mkdir(path.join(base, 'unrelated'));
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(physical, 'child', 'AGENTS.md'), '中文');
  const policyRoot = mode === 'selected-root' ? path.join(alias, 'child')
    : mode === 'ancestor-root' ? alias : path.join(base, 'unrelated');
  const policy = { root: policyRoot, files: { [mode === 'ancestor-root' ? 'child/AGENTS.md' : 'AGENTS.md']: 'utf-8' }, defaultEncoding: 'gbk' };
  const reader = await createAdmittedDirectoryReader({ domainId: 'asset', viewId: 'capture', root: path.join(alias, 'child'), textEncoding: policy });
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'ready', content: '中文' });
  if (mode === 'unrelated-root') {
    expect(decode.mock.calls[0]![0]).not.toHaveProperty('encoding');
    expect(decode.mock.calls[0]![0]).not.toHaveProperty('defaultEncoding');
  } else expect(decode).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'utf-8', defaultEncoding: 'gbk' }));
  expect(policy.root).toBe(policyRoot);
});

it('uses newly admitted same-pin target policy rather than the symlink alias rule', async () => {
  const decode = codec();
  let policy = { files: { 'AGENTS.md': 'gbk' } as Record<string, string> };
  const readPath = vi.fn(async (_branch: string, target: string) => target === ''
    ? { path: target, state: { kind: 'directory' as const }, origin: 'base' as const }
    : { path: target, state: target === 'AGENTS.md' ? { kind: 'symlink' as const, symlinkTarget: 'guidance.md' }
      : { kind: 'regular-file' as const, objectHash: 'raw-hash', byteLength: 4 }, origin: 'base' as const });
  const reader = createPinnedResourceReader({ domainId: 'project', pin: { branchId: 'source', workspaceId: 'workspace', revision: 7, root: 'root' } as WorkingStatePinnedRoot,
    coverage: { kind: 'complete' }, textEncoding: () => policy,
    admitSymlinkTarget: async target => { policy = { files: { ...policy.files, [target]: 'utf-8' } }; },
    store: { readPath, readContent: async () => Buffer.from('BODY'), listPaths: vi.fn() } });
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'ready', content: 'BODY', reference: { canonicalId: 'resource:project/guidance.md' } });
  expect(decode).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'utf-8' }));
});

it('freezes Auto and selected file rules when reading captured Documents', async () => {
  const readSnapshot = vi.fn(async () => ({ status: 'missing' as const, resource: { workspaceId: 'workspace', resourceId: 'AGENTS.md' } }));
  const policy = { files: { 'AGENTS.md': 'gbk' } };
  const reader = createDocumentResourceReader({ domainId: 'project', viewId: 'capture', workspaceId: 'workspace', textEncoding: policy,
    documents: { readSnapshot }, list: vi.fn() });
  policy.files['AGENTS.md'] = 'utf-8';
  await reader.read('AGENTS.md'); await reader.read('OTHER.md');
  expect(readSnapshot.mock.calls).toEqual([
    [{ workspaceId: 'workspace', resourceId: 'AGENTS.md' }, { encoding: 'gbk' }],
    [{ workspaceId: 'workspace', resourceId: 'OTHER.md' }, { encoding: 'auto' }],
  ]);
});

it('keeps binary and codec failures distinct from missing resources', async () => {
  const decode = codec();
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-resource-invalid-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0, 1, 2]));
  const reader = await createAdmittedDirectoryReader({ domainId: 'asset', viewId: 'capture', root });
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'invalid', reason: 'Resource is binary, not text' });
  decode.mockRejectedValueOnce(new Error('Native text service unavailable'));
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'unavailable' });
  expect(await reader.read('absent.md')).toMatchObject({ status: 'missing' });
});
