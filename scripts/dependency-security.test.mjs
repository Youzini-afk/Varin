import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Resolve from real consumers, rather than Bun's editable top-level patch copies.
const web = createRequire(new URL('../packages/web/package.json', import.meta.url));
const proxy = createRequire(web.resolve('http-proxy-middleware'));
const micromatch = createRequire(proxy.resolve('micromatch'));
const braces = micromatch('braces');
const bracesEntry = micromatch.resolve('braces');
const electron = createRequire(createRequire(new URL('../packages/electron/package.json', import.meta.url)).resolve('electron/package.json'));
const get = createRequire(electron.resolve('@electron/get'));
const got = createRequire(get.resolve('got'));
const cache = createRequire(got.resolve('cacheable-request'));
const CachePolicy = cache('http-cache-semantics');
const transformers = createRequire(web.resolve('@huggingface/transformers'));
const { sprintf, vsprintf } = transformers('sprintf-js');

test('security exceptions apply only to the pinned, behavior-verified dependency versions', () => {
  assert.equal(micromatch('braces/package.json').version, '3.0.3');
  assert.equal(cache('http-cache-semantics/package.json').version, '4.2.0');
  assert.equal(transformers('sprintf-js/package.json').version, '1.1.3');
});

test('floating-point formatting handles hostile precision without losing normal formatting', () => {
  for (const type of ['e', 'f', 'g']) {
    for (const precision of ['101', '9999999999999999999999999999999999999999']) {
      assert.equal(sprintf(`%.${precision}${type}`, 1.25), sprintf(`%.100${type}`, 1.25));
    }
  }
  assert.equal(sprintf('%.0g', 1.25), '1');
  assert.equal(vsprintf('%+08.2f / %.3e / %.3g / %.3s', [1.25, 1.25, 1.25, 'hello']), '+0001.25 / 1.250e+0 / 1.25 / hel');
});

test('brace compilation, expansion and stringification survive deeply nested legal patterns', () => {
  // A smaller V8 stack reproduces the recursive walk failure within the package's existing length limit.
  const result = spawnSync(process.execPath, ['--stack-size=256', '-e', `
    const assert = require('node:assert/strict');
    const braces = require(process.argv[1]);
    const pattern = '{'.repeat(4000) + 'x' + '}'.repeat(4000);
    assert.equal(braces.compile(pattern), pattern);
    assert.equal(braces.stringify(pattern), pattern);
    assert.deepEqual(braces.expand(pattern), [pattern]);
  `, bracesEntry], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('iterative brace walks preserve normal alternatives, ranges, escaping and expansion options', () => {
  assert.deepEqual(braces.expand('src/{client,host}/v{1..3}.ts'), ['src/client/v1.ts', 'src/client/v2.ts', 'src/client/v3.ts', 'src/host/v1.ts', 'src/host/v2.ts', 'src/host/v3.ts']);
  assert.deepEqual(braces.expand('{{a,b},{c,d}}'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(braces.expand('file-{01..03}'), ['file-01', 'file-02', 'file-03']);
  assert.deepEqual(braces.expand('a{3..1}b'), ['a3b', 'a2b', 'a1b']);
  assert.deepEqual(braces.expand('${literal}'), ['${literal}']);
  assert.deepEqual(braces.expand('{{a,a},}', { nodupes: true, noempty: true }), ['a']);
  assert.equal(braces.compile('{broken', { escapeInvalid: true }), '\\{broken');
  const regex = new RegExp('^' + braces.compile('src/{client,host}/v{1..3}.ts') + '$');
  assert.equal(regex.test('src/client/v2.ts'), true);
  assert.equal(regex.test('src/other/v2.ts'), false);
  assert.throws(() => braces.expand('{1..2000}'), /range limit/);
});

const request = { url: 'https://fixture.invalid/resource', headers: { host: 'fixture.invalid' } };
const staleRequest = { ...request, headers: { ...request.headers, 'cache-control': 'max-stale=999999999' } };
const policy = (headers, shared = true) => new CachePolicy(request, { status: 200, headers }, { shared });
test('max-stale cannot disclose security-zeroed shared-cookie entries, including persisted policies', () => {
  const original = policy({ 'cache-control': 'max-age=600', 'set-cookie': 'fixture=private' });
  for (const current of [original, CachePolicy.fromObject(original.toObject())]) {
    const result = current.evaluateRequest(staleRequest);
    assert.equal(result.response, undefined);
    assert.equal(result.revalidation.synchronous, true);
  }
});

test('response revalidation and storage prohibitions survive a max-stale request', () => {
  for (const directive of ['proxy-revalidate, max-age=600', 'no-cache', 'no-store']) {
    const result = policy({ 'cache-control': directive }).evaluateRequest(staleRequest);
    assert.equal(result.response, undefined, directive);
    assert.equal(result.revalidation.synchronous, true, directive);
  }
});

test('ordinary stale reuse and explicit/private cookie caching remain available', () => {
  for (const current of [
    policy({ 'cache-control': 'max-age=0' }),
    policy({ 'cache-control': 'public, max-age=600', 'set-cookie': 'fixture=public' }),
    policy({ 'cache-control': 'max-age=600', 'set-cookie': 'fixture=private' }, false),
  ]) assert.ok(current.evaluateRequest(staleRequest).response);
});
