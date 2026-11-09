import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createLanguageOwner } from './language-owner.js';
import type { LanguageQuery } from './protocol.generated.js';

it('keeps raw format identity and explicit interpretation across the structure bridge', async () => {
  const raw = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const format = { encoding: 'gbk', bom: false, lineEnding: 'lf', defaultLineEnding: 'lf', source: 'explicit' };
  const compute = vi.fn(async (_query: unknown, _input: unknown) => ({ records: [
    { kind: 'structure', path: 'legacy.c', revision: 'raw-revision', data: { status: 'ready', contentHash: hash(Buffer.from('中文')), rawContentHash: hash(raw), sourceObjectHash: 'ranges-sha256-descriptor', format } },
    { kind: 'structure-part', path: 'legacy.c', revision: 'raw-revision', data: { category: 'symbols', items: [{ name: '中文', range: { startByte: 0, endByte: 6, sourceStartByte: 0, sourceEndByte: 4 } }] } },
  ] }));
  const owner = createLanguageOwner({
    documents: {}, sources: { checkPath: vi.fn(async () => undefined), compute },
    structure: () => ({ unitsRecipe: async () => 'recipe' }),
  } as unknown as Parameters<typeof createLanguageOwner>[0]);
  const root = { hostId: 'host', rootId: 'root', canonicalRoot: '/repo' };
  const query: LanguageQuery = { runId: 'run', threadId: 'thread', grantId: 'grant',
    source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: null, revision: null, live_root: root },
    physicalRoot: root, method: 'structure', path: 'legacy.c', encoding: 'gbk' };
  const result = await owner(query, new AbortController().signal);
  expect(result).toMatchObject({ status: 'ready', rawContentHash: hash(raw), sourceObjectHash: 'ranges-sha256-descriptor', format });
  expect(result.contentHash).not.toBe(result.rawContentHash);
  expect(result.items[0]).toMatchObject({ range: { endByte: 6, sourceEndByte: 4 } });
  expect(compute.mock.calls[0]?.[1]).toMatchObject({ encoding: 'gbk' });
});
