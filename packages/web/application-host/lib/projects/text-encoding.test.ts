import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectConfigRuntime } from './project-config.js';
import type { KernelTextConversionsPage } from '../kernel/kernel-client.js';
import { createProjectTextEncodingService, sourceTextEncodingChoiceId, projectTextEncodingForSource, textEncodingForResource, textEncodingNamespace, type TextEncodingSource } from './text-encoding.js';

describe('project text interpretation', () => {
  it('keeps remembered choices in the original multi-folder namespace', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'varin-text-settings-'));
    try {
      const config = createProjectConfigRuntime({ fsPromises, path, projectsDirPath: temp });
      const service = createProjectTextEncodingService({
        projects: async () => [{ id: 'project', path: '/code/main', additionalPaths: ['/code/legacy'] }],
        canonicalRoot: async id => id === 'main' ? '/code/main' : '/code/legacy',
        read: config.readTextEncoding, remember: config.rememberTextEncoding,
      });
      await service.remember({ workspaceId: 'legacy', resourceId: 'src/test.c' }, 'gbk');
      expect(await service.resolve({ workspaceId: 'legacy', resourceId: 'src/test.c' })).toEqual({ encoding: 'gbk' });
      expect(await service.resolve({ workspaceId: 'main', resourceId: 'src/test.c' })).toEqual({});
      expect(await service.policyFor('legacy')).toEqual({ root: '/code/legacy', files: { 'src/test.c': 'gbk' }, choiceRevisions: { 'src/test.c': 1 } });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it('freezes exact and longest-directory rules without turning a default into a forced encoding', () => {
    const namespace = textEncodingNamespace('/code/src', [{ id: 'project', path: '/code' }]);
    const policy = projectTextEncodingForSource({ defaultEncoding: 'gbk', files: {
      'src/': 'utf-8', 'src/old/': 'gbk', 'src/old/one.c': 'utf-16le', '/code/src/old/one.c': 'utf-8',
    } }, namespace);
    expect(textEncodingForResource(policy, 'new.c')).toEqual({ encoding: 'utf-8', defaultEncoding: 'gbk' });
    expect(textEncodingForResource(policy, 'old/two.c')).toEqual({ encoding: 'gbk', defaultEncoding: 'gbk' });
    expect(textEncodingForResource(policy, 'old/one.c')).toEqual({ encoding: 'utf-8', defaultEncoding: 'gbk' });
    expect(textEncodingForResource({ defaultEncoding: 'gbk' }, 'one.c')).toEqual({ defaultEncoding: 'gbk' });
    const nested = projectTextEncodingForSource({ files: { 'src/': 'gbk', '/code/': 'utf-8' } }, namespace);
    expect(textEncodingForResource(nested, 'one.c')).toEqual({ encoding: 'gbk' });
  });

  it('uses the closest project and Windows path identity without conflating POSIX names', () => {
    expect(textEncodingNamespace('C:\\Code\\Nested', [{ id: 'broad', path: 'c:/code' }, { id: 'nested', path: 'C:/CODE/Nested' }]).projectId).toBe('nested');
    const policy = projectTextEncodingForSource({ files: { 'SRC/A.C': 'gbk' } }, { root: 'c:/code', projectRoot: 'c:/code' });
    expect(textEncodingForResource(policy, 'Src/A.c').encoding).toBe('gbk');
    expect(textEncodingForResource({ root: '/code', files: { 'A.c': 'gbk' } }, 'a.c').encoding).toBeUndefined();
    const scoped = { root: '/code', defaultEncoding: 'gbk', files: { './': 'gbk' } };
    expect(textEncodingForResource(scoped, '/code/a.c')).toEqual({ encoding: 'gbk', defaultEncoding: 'gbk' });
    expect(textEncodingForResource(scoped, '/other/a.c')).toEqual({});
  });

  it('serializes preference and existing project writes without dropping either', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'varin-text-settings-'));
    try {
      const runtime = createProjectConfigRuntime({ fsPromises, path, projectsDirPath: temp });
      const configPath = runtime.resolveProjectConfigPath('project');
      await writeFile(configPath, JSON.stringify({ custom: 'keep', textEncoding: { defaultEncoding: 'gbk' } }));
      await Promise.all([
        runtime.rememberTextEncoding('project', '/code/one.c', 'utf-8'),
        runtime.rememberTextEncoding('project', '/code/two.c', 'gbk'),
        runtime.upsertScheduledTask('project', { name: 'Daily', enabled: true,
          target: { kind: 'new_work', model: { providerId: 'provider', modelId: 'model' }, sourceMode: 'fixed_branch', goal: null },
          schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' }, execution: { prompt: 'Review' } }),
      ]);
      const stored = JSON.parse(await readFile(configPath, 'utf8'));
      expect(stored.custom).toBe('keep');
      expect(stored.scheduledTasks).toHaveLength(1);
      expect(stored.textEncoding).toEqual({ defaultEncoding: 'gbk', files: { '/code/one.c': 'utf-8', '/code/two.c': 'gbk' }, choiceRevisions: { '/code/one.c': 1, '/code/two.c': 1 } });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});


async function conversionHarness() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'varin-conversion-settings-'));
  const runtime = createProjectConfigRuntime({ fsPromises, path, projectsDirPath: temp });
  await writeFile(runtime.resolveProjectConfigPath('project'), JSON.stringify({ custom: 'preserved', textEncoding: { files: { 'src/': 'gbk' } } }));
  const receipt = { operationId: 'latest-write', conversionOperationId: 'conversion', runId: 'old-run',
    path: 'src/a.c', rawHash: 'converted-raw', sourceEncoding: 'gbk', targetEncoding: 'utf-8',
    choiceRevision: 0, policyRoot: '/code', canonicalRoot: '/code', sourceMode: 'live_root' };
  let rawHash = receipt.rawHash;
  const client = {
    fileTextConversions: vi.fn(async (): Promise<KernelTextConversionsPage> => ({ conversions: [{ ...receipt }], nextCursor: null })),
    fileRead: vi.fn(async () => ({ missing: false, content: { hash: rawHash, byteLength: 0, nextOffset: 0, eof: true } })),
  };
  const source: TextEncodingSource = { rootId: 'root', canonicalRoot: '/code', client };
  const createService = () => createProjectTextEncodingService({ projects: async () => [{ id: 'project', path: '/code' }],
    canonicalRoot: async () => '/code', read: runtime.readTextEncoding, remember: runtime.rememberTextEncoding,
    reconcile: runtime.reconcileTextEncoding, source: async () => source });
  return { runtime, receipt, client, source, createService, service: createService(),
    raw: (value: string) => { rawHash = value; }, cleanup: () => rm(temp, { recursive: true, force: true }) };
}

describe('durable Agent conversion reconciliation', () => {
  it('replays committed choices after restart before the next read and preserves unrelated settings', async () => {
    const f = await conversionHarness();
    try {
      // No event is delivered. A freshly constructed service uses the original durable receipt.
      expect(await f.createService().resolve({ workspaceId: 'workspace', resourceId: 'src/a.c' })).toEqual({ encoding: 'utf-8' });
      expect(f.client.fileTextConversions).toHaveBeenCalledWith({ workspaceId: 'workspace', rootId: 'root', path: 'src/a.c' }, undefined);
      expect(f.client.fileRead).toHaveBeenCalledWith({ workspaceId: 'workspace', rootId: 'root', path: 'src/a.c', raw: true, offset: 0, length: 0 }, undefined);
      expect((await f.runtime.readTextEncoding('project')).files).toEqual({ 'src/': 'gbk', '/code/src/a.c': 'utf-8' });
      expect(JSON.parse(await readFile(f.runtime.resolveProjectConfigPath('project'), 'utf8')).custom).toBe('preserved');
      await f.service.policyFor('workspace');
      expect(f.client.fileRead).toHaveBeenCalledTimes(1); // already persisted, no full-file hash on every policy read
    } finally { await f.cleanup(); }
  });

  it('allows consecutive conversions in one Run but never overwrites a later manual interpretation', async () => {
    const f = await conversionHarness();
    try {
      await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'gbk');
      f.receipt.choiceRevision = 1;
      expect(textEncodingForResource(await f.service.policyFor('workspace'), 'src/a.c').encoding).toBe('utf-8');
      Object.assign(f.receipt, { sourceEncoding: 'utf-8', targetEncoding: 'gbk', rawHash: 'second-conversion' });
      f.raw('second-conversion');
      expect(textEncodingForResource(await f.service.policyFor('workspace'), 'src/a.c').encoding).toBe('gbk');
      expect((await f.runtime.readTextEncoding('project')).choiceRevisions).toEqual({ '/code/src/a.c': 1 });
      // Choosing the same codec again is still a newer explicit decision.
      await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'gbk');
      Object.assign(f.receipt, { sourceEncoding: 'gbk', targetEncoding: 'utf-8', rawHash: 'late-old-run' });
      f.raw('late-old-run');
      expect(textEncodingForResource(await f.createService().policyFor('workspace'), 'src/a.c').encoding).toBe('gbk');
      expect((await f.runtime.readTextEncoding('project')).choiceRevisions).toEqual({ '/code/src/a.c': 2 });
    } finally { await f.cleanup(); }
  });

  it('rejects changed bytes, another namespace and escaping paths without persisting a choice', async () => {
    const f = await conversionHarness();
    try {
      f.raw('external-change');
      expect(textEncodingForResource(await f.service.policyFor('workspace'), 'src/a.c').encoding).toBe('gbk');
      f.raw(f.receipt.rawHash);
      f.receipt.policyRoot = '/other';
      await f.service.policyFor('workspace');
      f.receipt.policyRoot = '/code'; f.receipt.path = '../outside.c';
      await f.service.policyFor('workspace');
      expect((await f.runtime.readTextEncoding('project')).files).toEqual({ 'src/': 'gbk' });
      expect(f.client.fileRead).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('keeps isolated subtree conversions in their own source and projects manual revisions identically', async () => {
    const f = await conversionHarness();
    try {
      await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'gbk');
      const copy = { ...f.source, canonicalRoot: '/temporary/copy/src', sourcePath: 'src' };
      Object.assign(f.receipt, { path: 'a.c', policyRoot: '/code/src', canonicalRoot: copy.canonicalRoot,
        choiceRevision: 1, sourceMode: 'native_workspace' });
      const policy = await f.service.policyFor('workspace', copy);
      expect(policy.root).toBe('/code/src');
      expect(policy.choiceRevisions).toEqual({ 'a.c': 1 });
      expect(textEncodingForResource(policy, 'a.c').encoding).toBe('utf-8');
      expect((await f.runtime.readTextEncoding('project')).files?.['/code/src/a.c']).toBe('gbk');
      await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'gbk');
      expect(textEncodingForResource(await f.service.policyFor('workspace', copy), 'a.c').encoding).toBe('gbk');
    } finally { await f.cleanup(); }
  });

  it('rechecks the choice inside the shared project transaction and survives empty metadata pages', async () => {
    const f = await conversionHarness();
    try {
      f.client.fileTextConversions.mockImplementationOnce(async () => {
        await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'gbk');
        return { conversions: [{ ...f.receipt }], nextCursor: null };
      });
      expect(textEncodingForResource(await f.service.policyFor('workspace'), 'src/a.c').encoding).toBe('gbk');
      expect(f.client.fileRead).not.toHaveBeenCalled();
      f.receipt.choiceRevision = 1;
      f.client.fileTextConversions.mockImplementationOnce(async () => ({ conversions: [], nextCursor: 'earlier-path' }));
      expect(textEncodingForResource(await f.service.policyFor('workspace'), 'src/a.c').encoding).toBe('utf-8');
      expect(f.client.fileTextConversions).toHaveBeenLastCalledWith({ workspaceId: 'workspace', rootId: 'root', cursor: 'earlier-path' }, undefined);
    } finally { await f.cleanup(); }
  });
});

it('reads a fixed source policy without opening its former physical root', async () => {
  const f = await conversionHarness();
  try {
    f.client.fileTextConversions.mockRejectedValue(new Error('The physical directory is offline'));
    expect(textEncodingForResource(await f.service.policyFor('workspace', null), 'src/a.c').encoding).toBe('gbk');
    expect(f.client.fileTextConversions).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it.each([
  { root: '/code', files: { 'src/a.c': 'gbk' }, choiceRevisions: { 'src/a.c': 4 } },
  { root: '/code/src', files: { 'a.c': 'gbk' }, choiceRevisions: { 'a.c': 4 } },
])('projects a captured subtree policy exactly once before overlaying its own conversion', async frozen => {
  const f = await conversionHarness();
  try {
    const sourcePath = frozen.root === '/code' ? 'src' : undefined;
    Object.assign(f.receipt, { path: 'a.c', policyRoot: '/code/src', canonicalRoot: '/temporary/src', choiceRevision: 4 });
    const read = vi.fn(async () => { throw new Error('Current live settings must not reinterpret a captured source'); });
    const service = createProjectTextEncodingService({ projects: async () => [{ id: 'project', path: '/code' }],
      canonicalRoot: async () => { throw new Error('The old physical registration must not replace a frozen namespace'); }, read,
      remember: f.runtime.rememberTextEncoding, reconcile: f.runtime.reconcileTextEncoding });
    const policy = await service.policyFor('workspace', { ...f.source, canonicalRoot: '/temporary/src', frozenPolicy: frozen,
      ...(sourcePath ? { sourcePath } : {}) });
    expect(policy).toEqual({ root: '/code/src', files: { 'a.c': 'utf-8' }, choiceRevisions: { 'a.c': 4 } });
    expect(read).not.toHaveBeenCalled();
    expect((await f.runtime.readTextEncoding('project')).files).toEqual({ 'src/': 'gbk' });
  } finally { await f.cleanup(); }
});

it('keeps captured empty Auto authoritative over current forced settings', async () => {
  const f = await conversionHarness();
  try {
    f.client.fileTextConversions.mockResolvedValue({ conversions: [], nextCursor: null });
    const policy = await f.service.policyFor('workspace', { ...f.source, canonicalRoot: '/temporary/copy', frozenPolicy: {} });
    expect(textEncodingForResource(policy, 'src/a.c')).toEqual({});
  } finally { await f.cleanup(); }
});


it.each([{ files: { 'src/a.c': 'gbk' } }, {}])('keeps default native Document source frozen before consulting live settings', async frozenPolicy => {
  const f = await conversionHarness();
  try {
    Object.assign(f.source, { canonicalRoot: '/temporary/copy', frozenPolicy: { ...frozenPolicy, root: '/code' } });
    f.client.fileTextConversions.mockResolvedValue({ conversions: [], nextCursor: null });
    await f.service.remember({ workspaceId: 'workspace', resourceId: 'src/a.c' }, 'utf-8');
    expect(await f.service.resolve({ workspaceId: 'workspace', resourceId: 'src/a.c' }))
      .toEqual('files' in frozenPolicy ? { encoding: 'gbk' } : {});
  } finally { await f.cleanup(); }
});


it.each([undefined, 'src'])('remembers captured native Document corrections only on the actual branch across remounts', async sourcePath => {
  const f = await conversionHarness();
  try {
    const choiceId = sourceTextEncodingChoiceId('workspace', 'branch');
    const frozenPolicy = { root: '/code', files: { 'src/a.c': 'utf-8' }, choiceRevisions: { 'src/a.c': 7 } };
    Object.assign(f.source, { canonicalRoot: '/temporary/copy', frozenPolicy, choiceId, ...(sourcePath ? { sourcePath } : {}) });
    const resourceId = sourcePath ? 'a.c' : 'src/a.c';
    const resource = { workspaceId: 'workspace', resourceId };
    Object.assign(f.receipt, { canonicalRoot: f.source.canonicalRoot, path: resourceId, policyRoot: sourcePath ? '/code/src' : '/code' });
    expect(await f.service.resolve(resource)).toEqual({ encoding: 'utf-8' });
    await f.service.remember(resource, 'gbk');
    expect(await f.createService().resolve(resource)).toEqual({ encoding: 'gbk' });
    expect((await f.runtime.readTextEncoding(choiceId)).choiceRevisions).toEqual({ '/code/src/a.c': 8 });
    expect((await f.runtime.readTextEncoding('project')).files).toEqual({ 'src/': 'gbk' });
    // A later explicit conversion remains valid, but a subsequent manual reopen is newer.
    f.receipt.choiceRevision = 8;
    expect(await f.service.resolve(resource)).toEqual({ encoding: 'utf-8' });
    await f.service.remember(resource, 'gbk');
    Object.assign(f.source, { rootId: 'remounted', canonicalRoot: '/another/mount' });
    f.receipt.canonicalRoot = f.source.canonicalRoot;
    expect(await f.createService().resolve(resource)).toEqual({ encoding: 'gbk' });
    expect((await f.runtime.readTextEncoding(choiceId)).choiceRevisions).toEqual({ '/code/src/a.c': 9 });
    // Another isolated branch retains its own original interpretation.
    expect(textEncodingForResource(await f.service.policyFor('workspace', { ...f.source,
      choiceId: sourceTextEncodingChoiceId('workspace', 'other-branch') }), resourceId).encoding).toBe('utf-8');
    expect(frozenPolicy.files['src/a.c']).toBe('utf-8');
    expect(frozenPolicy.choiceRevisions['src/a.c']).toBe(7);
  } finally { await f.cleanup(); }
});
