import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelTokenizers } from './tokenizers.js';
import { modelList, openRouterModels } from './discovery.js';
import { directoryModels } from './directory-models.js';
import { ModelsService } from './service.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelChannel, ModelTokenizer } from '@varin/application-client';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(join(tmpdir(), 'varin-tokenizers-')); roots.push(dir); return dir; }
const body = JSON.stringify({ version: '1.0', model: { type: 'WordLevel', vocab: { '[UNK]': 0, 'hello': 1 }, unk_token: '[UNK]' } });

test('public metadata selects arbitrary repositories; preparation shares pinned content without delaying a conversation', async () => {
  const source: ModelTokenizer = { kind: 'huggingface', repository: 'example/new-model', revision: 'release/2' };
  expect(modelList({ data: [{ id: 'private-alias', hugging_face_id: source.repository }] })[0]?.tokenizer).toEqual({ kind: 'huggingface', repository: source.repository });
  expect(openRouterModels({ data: [{ id: 'new-model', tokenizer: source }] })[0]?.tokenizer).toEqual(source);
  expect(modelList({ data: [{ id: 'host-file', tokenizer: { kind: 'file', path: '/private/key' } }] })[0]?.tokenizer).toBeUndefined();
  const model = new ModelsService(await root(), { projectTrusted: () => false });
  expect(directoryModels({ local: { models: { arbitrary: { type: 'language', modalities: { output: ['text'] }, tokenizer: source } } } }, model.types.get('local')!)?.[0]?.tokenizer).toEqual(source);
  let deliver!: (response: Response) => void;
  const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(resolve => { deliver = resolve; }));
  const directory = await root();
  const cache = new ModelTokenizers(directory, () => ({ fetch, signal: new AbortController().signal }), () => {});
  const pending = cache.prepare(source);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0]?.[0]).toBe('https://huggingface.co/example/new-model/resolve/release%2F2/tokenizer.json');
  expect(await cache.resolve(source)).toBeUndefined();
  deliver(new Response(body, { headers: { 'x-repo-commit': 'frozen-revision' } }));
  const prepared = await pending;
  expect(prepared?.kind).toBe('file');
  if (prepared?.kind !== 'file') throw new Error('missing file');
  expect(await readFile(prepared.path, 'utf8')).toBe(body);
  expect(await cache.resolve(source)).toEqual(prepared);
  const reopened = new ModelTokenizers(directory, () => undefined, () => {});
  expect(await reopened.resolve(source)).toEqual(prepared);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('local changes create new immutable files and captured model configurations keep their tokenizer', async () => {
  const directory = await root(), path = join(directory, 'custom.json');
  await writeFile(path, body);
  const models = new ModelsService(directory, { projectTrusted: () => false });
  const source: ModelTokenizer = { kind: 'file', path };
  const first = await models.tokenizers.prepare(source);
  const channel: ModelChannel = { id: 'local', name: 'Local', type: 'local', enabled: true, baseUrl: 'http://localhost:1234/v1',
    authentication: { kind: 'none' }, parameters: {}, models: [{ id: 'arbitrary-model', name: 'Arbitrary', operations: ['chat'], enabled: true, tokenizer: source }] };
  await models.save(channel, (await models.read()).revision);
  const authority = createModelAuthority(models);
  const captured = await authority.resolveModel({ providerId: 'local', modelId: 'arbitrary-model' });
  try {
    expect(captured.configuration.tokenizer).toEqual(first);
    await writeFile(path, body.replace('hello', 'a different vocabulary'));
    const next = await models.tokenizers.prepare(source);
    expect(next).not.toEqual(first);
    expect(captured.configuration.tokenizer).toEqual(first);
    const fresh = await authority.resolveModel({ providerId: 'local', modelId: 'arbitrary-model' });
    const inherited = await authority.resolveModel({ providerId: 'local', modelId: 'arbitrary-model' },
      { configuration: captured.configuration, credentialScope: await captured.credentialOwner.scope() });
    try {
      expect(fresh.configuration.tokenizer).toEqual(next);
      expect(inherited.configuration.tokenizer).toEqual(first);
      expect(fresh.configuration.configurationGeneration).toBe(captured.configuration.configurationGeneration);
    } finally { fresh.credentialOwner.release(); inherited.credentialOwner.release(); }
    if (first?.kind !== 'file') throw new Error('missing file');
    expect(await readFile(first.path, 'utf8')).toBe(body);
    await writeFile(path, 'invalid JSON');
    expect(await models.tokenizers.prepare(source)).toBeUndefined();
    expect(models.tokenizers.issue(source)).toContain('tokenizer.json');
  } finally { captured.credentialOwner.release(); }
});
