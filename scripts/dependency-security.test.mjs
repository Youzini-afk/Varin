import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
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
const logging = createRequire(createRequire(get.resolve('global-agent')).resolve('roarr'));
const { sprintf, vsprintf } = logging('sprintf-js');
const builtins = createRequire(new URL('../packages/extension-builtins/package.json', import.meta.url));
const bash = createRequire(builtins.resolve('bash-language-server/package.json'));
const bashConfig = bash('./out/config.js');
const { ShellCheckResultSchema } = bash('./out/shellcheck/types.js');
const mcp = createRequire(web.resolve('@modelcontextprotocol/client'));
const claude = createRequire(web.resolve('@anthropic-ai/claude-agent-sdk/core'));
const legacyMcp = createRequire(claude.resolve('@modelcontextprotocol/sdk/package.json'));
const rateLimit = createRequire(legacyMcp.resolve('express-rate-limit'));
const pwa = createRequire(web.resolve('vite-plugin-pwa'));
const workbox = createRequire(pwa.resolve('workbox-build'));
const nodeResolve = createRequire(workbox.resolve('@rollup/plugin-node-resolve'));

// GHSA-27r3-jxmh-p828: send the trailing bytes only after the compressed frame
// has parsed. Isolate the old uncaught decoder error, with no listener or large body.
test('Express drains late compressed-body bytes without crashing or detaching other consumers', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { createHash } from 'node:crypto';
    import { once } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { gzipSync, deflateSync } from 'node:zlib';
    const express = createRequire(import.meta.url)(process.argv[1]);
    const timeout = setTimeout(() => { throw new Error('Compressed request did not finish'); }, 3000);
    try {
      for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync]]) {
        for (const otherConsumer of [false, true]) {
          const first = Buffer.concat([compress('{"ok":true}'), Buffer.from([0])]);
          const trailing = Buffer.alloc(1024, 0x58);
          const req = Object.assign(new PassThrough(), { headers: {
            'content-type': 'application/json', 'content-encoding': encoding,
            'content-length': String(first.length + trailing.length),
          } });
          const drained = once(req, 'end');
          const hash = otherConsumer ? createHash('sha256') : undefined;
          const hashed = hash ? once(hash, 'finish') : Promise.resolve();
          if (hash) req.pipe(hash);
          try {
            const parsed = new Promise((resolve, reject) => {
              express.json()(req, {}, error => error ? reject(error) : resolve(req.body));
            });
            req.write(first);
            assert.deepEqual(await parsed, { ok: true });
            assert.equal(req.readableEnded, false, 'the trailer must arrive after parsing');
            req.end(trailing);
            await Promise.all([drained, hashed]);
            if (hash) assert.equal(hash.digest('hex'),
              createHash('sha256').update(first).update(trailing).digest('hex'));
          } finally {
            req.destroy();
            hash?.destroy();
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  `, web.resolve('express')], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('Express rejects an aborted JSON body once and releases its body-reader listeners', { timeout: 1000 }, async () => {
  const req = Object.assign(new PassThrough(), {
    headers: { 'content-type': 'application/json', 'content-length': '100' },
  });
  let completions = 0;
  try {
    const outcome = new Promise(resolve => web('express').json()(req, {}, error => {
      completions += 1;
      resolve(error);
    }));
    req.write('{"text":');
    req.emit('aborted');
    req.destroy();
    const error = await outcome;
    assert.equal(error.status, 400);
    assert.equal(error.type, 'request.aborted');
    assert.equal(error.code, 'ECONNABORTED');
    assert.equal(req.body, undefined);
    assert.equal(completions, 1);
    for (const event of ['aborted', 'data', 'end', 'error', 'close']) assert.equal(req.listenerCount(event), 0, event);
  } finally {
    req.destroy();
  }
});

test('security exceptions apply only to the pinned, behavior-verified dependency versions', () => {
  assert.equal(micromatch('braces/package.json').version, '3.0.3');
  assert.equal(cache('http-cache-semantics/package.json').version, '4.2.0');
  assert.equal(logging('sprintf-js/package.json').version, '1.1.3');
  assert.equal(nodeResolve('deepmerge/package.json').version, '4.3.1');
});

test('installed PWA merge consumers preserve plain prototypes and normal merge options', () => {
  const mergeEntries = [nodeResolve.resolve('deepmerge'), nodeResolve.resolve('deepmerge/dist/umd.js')];
  for (const entry of mergeEntries) {
    const merge = nodeResolve(entry);
    const payload = JSON.parse('{"session":{"__proto__":{"admin":true}}}');
    for (const target of [{ session: null }, { session: undefined }, { session: false }, { session: Object.create(null) }, JSON.parse('{"session":{"__proto__":null}}')]) {
      const value = merge(target, payload);
      assert.equal(Object.getPrototypeOf(value.session), Object.prototype);
      assert.equal(value.session.admin, undefined);
      assert.equal(Object.prototype.admin, undefined);
    }
    const target = JSON.parse('{"__proto__":{"admin":true},"normal":1}');
    const copied = merge(target, { other: 2 });
    assert.equal(Object.getPrototypeOf(copied), Object.prototype);
    assert.equal(copied.admin, undefined);
    assert.equal(copied.normal, 1);
    const symbol = Symbol('merge-data');
    const ordinary = merge({ settings: { a: 1 }, files: ['a'], [symbol]: { a: true } }, { settings: { b: 2 }, files: ['b'], [symbol]: { b: true } });
    assert.deepEqual(ordinary.settings, { a: 1, b: 2 });
    assert.deepEqual(ordinary.files, ['a', 'b']);
    assert.deepEqual(ordinary[symbol], { a: true, b: true });
    assert.deepEqual(merge({ files: ['a'] }, { files: ['b'] }, { arrayMerge: (_, source) => source }), { files: ['b'] });
    assert.deepEqual(merge({ settings: { a: 1 } }, { settings: { b: 2 } }, { customMerge: key => key === 'settings' ? (a, b) => ({ total: a.a + b.b }) : undefined }), { settings: { total: 3 } });
  }
});

test('installed MCP rate-limit IP parsing keeps IPv6 classification and family boundaries accurate', () => {
  const { Address4, Address6 } = rateLimit('ip-address');
  for (const address of ['fe80::1', 'fe81::1', 'fe8f::1', 'febf::1']) assert.equal(new Address6(address).isLinkLocal(), true, address);
  assert.equal(new Address6('2001:4860:4860::8888').isLinkLocal(), false);
  const v4 = new Address4('10.0.0.1');
  const v6 = new Address6('a00::1');
  assert.equal(v6.isInSubnet(new Address4('10.0.0.0/8')), false);
  assert.equal(v4.isHostInSubnet(new Address6('::/0')), false);
  assert.equal(v4.isInSubnet(new Address4('10.0.0.0/8')), true);
  assert.equal(new Address6('64:ff9b:1::a00:1').isGlobal(), false);
  assert.equal(rateLimit('express-rate-limit').ipKeyGenerator('2001:db8::1'), '2001:db8::/56');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { Address6 } = require(process.argv[1]);
    assert.equal(Address6.isValid('x'.repeat(100000)), false);
    assert.equal(Address6.isValid('::1' + '%'.repeat(100000) + '\\n'), false);
    assert.equal(new Address6('fe80::1%eth0').zone, '%eth0');
  `, rateLimit.resolve('ip-address')], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('MCP and Bash consumers reject oversized bounded Zod collections before walking elements', () => {
  for (const consumer of [mcp, bash]) {
    assert.equal(consumer('zod/package.json').version, '4.6.7');
    const { z } = consumer('zod');
    let parsed = 0;
    const element = z.string().refine(() => { parsed += 1; return true; });
    for (const [schema, value] of [
      [z.array(element).max(1), ['one', 'two']],
      [z.set(element).max(1), new Set(['one', 'two'])],
      [z.map(element, element).size(1), new Map([['one', '1'], ['two', '2']])],
    ]) {
      const result = schema.safeParse(value);
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
      assert.equal(parsed, 0);
    }
    assert.deepEqual(z.array(element).max(1).parse(['one']), ['one']);
    assert.equal(parsed, 1);
  }
});

// Upstream Zod 4 migration: https://github.com/bash-lsp/bash-language-server/commit/320b3fc77806ec53f220d0dbae767b98b3991f5c
test('Bash configuration retains nested defaults and only supplied initialization options', () => {
  const defaults = bashConfig.getDefaultConfiguration();
  assert.deepEqual(defaults.shfmt, {
    path: 'shfmt', additionalArguments: [], ignoreEditorconfig: false,
    languageDialect: 'auto', binaryNextLine: false, caseIndent: false,
    funcNextLine: false, keepPadding: false, simplifyCode: false, spaceRedirects: false,
  });
  assert.deepEqual(bashConfig.InitializationOptionsSchema.parse({}), {});
  assert.deepEqual(bashConfig.InitializationOptionsSchema.parse({
    backgroundAnalysisMaxFiles: 0, clientSetting: true,
    shfmt: { path: ' custom-shfmt ', clientSetting: true },
  }), { backgroundAnalysisMaxFiles: 0, shfmt: { path: 'custom-shfmt' } });
  assert.deepEqual(bashConfig.ConfigSchema.parse({ shellcheckArguments: ' -e SC2001  -e SC2002 ' }).shellcheckArguments,
    ['-e', 'SC2001', '-e', 'SC2002']);
  assert.equal(bashConfig.InitializationOptionsSchema.safeParse({ shellcheckArguments: 42 }).success, false);
  assert.equal(bashConfig.InitializationOptionsSchema.safeParse({ shfmt: { additionalArguments: [42] } }).success, false);
});

test('Bash initialization preserves configured environment values and explicit empty tool paths', () => {
  const before = process.env;
  try {
    process.env = {
      SHELLCHECK_PATH: '', SHFMT_PATH: '', SHFMT_CASE_INDENT: 'true',
      SHELLCHECK_ARGUMENTS: '-e SC2001', BACKGROUND_ANALYSIS_MAX_FILES: '7',
    };
    const { config } = bashConfig.getConfigFromEnvironmentVariables();
    assert.equal(config.shellcheckPath, '');
    assert.equal(config.shfmt.path, '');
    assert.equal(config.shfmt.caseIndent, true);
    assert.equal(config.backgroundAnalysisMaxFiles, 7);
    assert.deepEqual(config.shellcheckArguments, ['-e', 'SC2001']);
    const options = bashConfig.InitializationOptionsSchema.parse({ shfmt: { languageDialect: 'bash' } });
    assert.deepEqual(options, { shfmt: { languageDialect: 'bash' } });
  } finally {
    process.env = before;
  }
});

test('Bash ShellCheck schema still accepts diagnostics and rejects malformed fixes', () => {
  const comment = {
    file: 'example.sh', line: 1, endLine: 1, column: 6, endColumn: 8,
    level: 'warning', code: 2086, message: 'Double quote to prevent globbing and word splitting.',
    fix: { replacements: [{ precedence: 1, line: 1, endLine: 1, column: 6, endColumn: 8,
      insertionPoint: 'beforeStart', replacement: '"$a"' }] },
  };
  const result = { comments: [comment, { ...comment, fix: null }] };
  assert.deepEqual(ShellCheckResultSchema.parse(result), result);
  assert.equal(ShellCheckResultSchema.safeParse({ comments: [{ ...comment, fix: { replacements: ['bad'] } }] }).success, false);
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

test('installed upload middleware tolerates a late asynchronous filter after teardown', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { PassThrough } = require('node:stream');
    const multer = require(process.argv[1]);
    const timer = setTimeout(() => { throw new Error('upload teardown did not finish'); }, 2000);
    const req = new PassThrough();
    const failure = new Error('rejected');
    let resume, parser, calls = 0;
    const body = ['first', 'second'].map(name => '--boundary\\r\\nContent-Disposition: form-data; name="' + name + '"; filename="a.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\nx\\r\\n').join('');
    req.headers = { 'content-type': 'multipart/form-data; boundary=boundary', 'content-length': Buffer.byteLength(body) };
    const upload = multer({ fileHwm: 1,
      streamHandler(request, stream) { parser = stream; request.pipe(stream); },
      fileFilter(request, file, callback) {
        if (file.fieldname === 'first') resume = callback;
        else request.once('end', () => setImmediate(() => callback(failure)));
      }
    }).any();
    upload(req, null, error => {
      assert.equal(error, failure); calls++;
      setImmediate(() => {
        parser.once('close', () => { assert.equal(calls, 1); assert.deepEqual(req.files, []); clearTimeout(timer); });
        resume(null, true);
      });
    });
    req.end(body);
  `, web.resolve('multer')], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('installed schema URI resolution rejects encoded schemes and keeps ordinary references', () => {
  const contract = createRequire(new URL('../packages/extension-contract/package.json', import.meta.url));
  const ajv = createRequire(contract.resolve('ajv'));
  const uri = ajv('fast-uri');
  assert.notEqual(uri.normalize('%6Aavascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(uri.resolve('https://example.com/schemas/root.json', 'child.json'), 'https://example.com/schemas/child.json');
});

test('installed build serializer escapes a script terminator at a function boundary', () => {
  const pwa = createRequire(web.resolve('vite-plugin-pwa'));
  const workbox = createRequire(pwa.resolve('workbox-build'));
  const terser = createRequire(workbox.resolve('@rollup/plugin-terser'));
  const serialize = terser('serialize-javascript');
  function payload() {}
  payload.toString = () => 'function payload(){}//</script';
  assert.doesNotMatch(serialize({ payload }, { space: 2 }), /<\/script/i);
  assert.equal(serialize({ normal: 'value' }), '{"normal":"value"}');
});
