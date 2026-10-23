import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = createRequire(new URL('../package.json', import.meta.url));
const web = createRequire(new URL('../packages/web/package.json', import.meta.url));
const mcp = createRequire(web.resolve('@modelcontextprotocol/client'));
const core = createRequire(mcp.resolve('@modelcontextprotocol/core'));
const openai = createRequire(web.resolve('openai'));
const hooks = createRequire(root.resolve('eslint-plugin-react-hooks'));
const errors = createRequire(hooks.resolve('zod-validation-error/v4'));
const { Client, InMemoryTransport, parseJSONRPCMessage } = web('@modelcontextprotocol/client');
const { ESLint, Linter } = root('eslint');
const reactHooks = root('eslint-plugin-react-hooks');

test('runtime and lint consumers resolve the secured Zod release through their own dependency graph', () => {
  const expected = root('./package.json').overrides.zod;
  for (const consumer of [mcp, core, openai, hooks, errors]) {
    assert.equal(consumer('zod/package.json').version, expected);
  }
});

test('MCP JSON-RPC parsing retains extension payloads and rejects malformed envelopes', () => {
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'read', arguments: { pages: [2, 3] }, _meta: { trace: 'fixture' },
    } },
    { jsonrpc: '2.0', id: 'response', result: { content: [], extension: { custom: true } } },
    { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid input', data: { field: 'pages' } } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'work', progress: 0 } },
  ]) assert.deepEqual(parseJSONRPCMessage(message), message);

  for (const message of [
    { jsonrpc: '1.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: {}, result: {} },
    { jsonrpc: '2.0', id: 1, error: { code: 'invalid', message: 'Invalid input' } },
    { jsonrpc: '2.0', method: 42 },
  ]) assert.throws(() => parseJSONRPCMessage(message));
});

async function mcpFixture(t, respond, initialize = {
  protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'varin-consumer-test', version: '1' });
  t.after(async () => { await client.close(); await serverTransport.close(); });
  serverTransport.onmessage = async request => {
    if (request.id === undefined) return;
    const result = request.method === 'initialize' ? initialize : await respond(request);
    await serverTransport.send({ jsonrpc: '2.0', id: request.id, result });
  };
  await serverTransport.start();
  await client.connect(clientTransport, { timeout: 1000 });
  return client;
}

test('MCP client/core validate real handshake, tool discovery and results with Zod 4', async t => {
  let malformed = false;
  const calls = [];
  const tool = { name: 'read', inputSchema: { type: 'object', properties: {
    pages: { type: 'array', items: { type: 'integer' } },
  }, required: ['pages'] }, annotations: { readOnlyHint: true } };
  const client = await mcpFixture(t, request => {
    if (request.method === 'tools/list') return { tools: [tool] };
    calls.push(request);
    return { content: [{ type: 'text', text: malformed ? 42 : 'complete' }] };
  });
  assert.deepEqual(client.getServerCapabilities(), { tools: {} });
  assert.deepEqual(await client.listTools(), { tools: [tool] });
  assert.deepEqual(await client.callTool({ name: 'read', arguments: { pages: [2, 3] } }), {
    content: [{ type: 'text', text: 'complete' }],
  });
  assert.deepEqual(calls[0].params.arguments, { pages: [2, 3] });
  malformed = true;
  await assert.rejects(client.callTool({ name: 'read', arguments: { pages: [2, 3] } }), /Invalid result for tools\/call/);
  assert.equal(calls.length, 2, 'invalid responses must not replay the tool');
});

test('MCP client rejects malformed initialization before exposing a usable session', async t => {
  let dispatched = 0;
  await assert.rejects(mcpFixture(t, () => { dispatched++; return {}; }, {
    protocolVersion: '2025-11-25', capabilities: [], serverInfo: { name: 'fixture', version: '1' },
  }), /Invalid result for initialize/);
  assert.equal(dispatched, 0);
});

// Varin's OpenAI runtime uses audio APIs, not structured outputs. Exercise the
// optional Zod peer as well so future imports cannot silently load an old major.
test('OpenAI optional Zod peer generates strict schemas and validates parsed completions', async () => {
  const { default: OpenAI } = web('openai');
  const { z } = openai('zod');
  const { zodResponseFormat, zodFunction } = web('openai/helpers/zod');
  const schema = z.object({ label: z.string(), count: z.number().int().nonnegative(), note: z.string().nullable() });
  const format = zodResponseFormat(schema, 'fixture');
  const input = { label: 'complete', count: 2, note: null };
  let content = JSON.stringify(input);
  const requests = [];
  const client = new OpenAI({ apiKey: 'synthetic-fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
      requests.push(JSON.parse(init.body));
      return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }] });
    },
  });
  const parse = () => client.chat.completions.parse({ model: 'fixture', messages: [
    { role: 'user', content: 'Return the fixture.' },
  ], response_format: format });
  assert.deepEqual((await parse()).choices[0].message.parsed, input);
  assert.equal(requests[0].response_format.json_schema.strict, true);
  const generated = requests[0].response_format.json_schema.schema;
  assert.deepEqual(generated.required, ['label', 'count', 'note']);
  assert.equal(generated.additionalProperties, false);
  assert.equal(generated.properties.count.type, 'integer');
  content = JSON.stringify({ ...input, count: 'two' });
  await assert.rejects(parse(), error => error.issues?.some(issue => issue.path.join('.') === 'count'));

  const tool = zodFunction({ name: 'fixture', parameters: schema });
  assert.equal(tool.function.strict, true);
  assert.deepEqual(tool.$parseRaw(JSON.stringify(input)), input);
  assert.throws(() => tool.$parseRaw(content));
});

test('Varin speech consumers use the real OpenAI SDK for audio bytes and multipart transcription', async t => {
  const { tsImport } = await import('tsx/esm/api');
  const { TTSService } = await tsImport('../packages/web/application-host/lib/tts/service.ts', import.meta.url);
  const { transcribeAudio } = await tsImport('../packages/web/application-host/lib/tts/stt.ts', import.meta.url);
  const bytes = Buffer.from('fixture-audio');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // The SDK checks the fetch implementation's FormData support locally.
    if (String(url) === 'data:,') return new Response('');
    requests.push(String(url));
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-fixture');
    if (String(url) === 'http://127.0.0.1:9999/v1/audio/speech') {
      assert.deepEqual(JSON.parse(init.body), { model: 'fixture', voice: 'coral', input: 'Read fixture', speed: 1 });
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
    }
    assert.equal(String(url), 'http://127.0.0.1:9999/v1/audio/transcriptions');
    assert.ok(init.body instanceof FormData);
    const file = init.body.get('file');
    assert.equal(file.name, 'audio.webm');
    assert.equal(file.type, 'audio/webm');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal(init.body.get('model'), 'fixture');
    assert.equal(init.body.get('response_format'), 'json');
    assert.equal(init.body.get('language'), 'en');
    return Response.json({ text: 'fixture transcript' });
  });
  const endpoint = { baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'synthetic-fixture', model: 'fixture' };
  const service = new TTSService();
  assert.deepEqual(await service.generateSpeechBuffer({ ...endpoint, text: 'Read fixture', voice: 'coral' }), bytes);
  assert.equal(await transcribeAudio({ ...endpoint, audioBuffer: bytes, mimeType: 'audio/webm', language: 'en' }), 'fixture transcript');
  assert.equal(requests.length, 2);
});

test('the actual Varin ESLint configuration retains hook errors and dependency warnings', async () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)),
    overrideConfigFile: fileURLToPath(new URL('../eslint.config.js', import.meta.url)) });
  const [result] = await eslint.lintText(`
    import { useEffect, useState } from 'react';
    export function Probe({ active, value }: { active: boolean; value: string }) {
      if (active) useState(0);
      useEffect(() => { console.log(value); }, []);
      return null;
    }
  `, { filePath: 'packages/ui/src/zod-consumer-fixture.tsx' });
  assert.equal(result.fatalErrorCount, 0);
  assert.ok(result.messages.some(message => message.ruleId === 'react-hooks/rules-of-hooks' && message.severity === 2));
  assert.ok(result.messages.some(message => message.ruleId === 'react-hooks/exhaustive-deps' && message.severity === 1));
});

test('react-hooks compiler defaults and Zod error formatting handle real compiler options', () => {
  const linter = new Linter();
  const lint = options => linter.verify('function Component() { return <div>{Math.random()}</div>; }', {
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': reactHooks }, rules: { 'react-hooks/purity': ['error', options] },
  });
  assert.ok(lint({}).some(message => message.ruleId === 'react-hooks/purity' && /impure function/.test(message.message)));
  assert.throws(() => lint({ target: 'not-a-version' }), /Not a valid target.*Validation error/);
  assert.throws(() => lint({ gating: { source: 12, importSpecifierName: false } }),
    error => /Validation error/.test(error.message) && /source/.test(error.message) && /importSpecifierName/.test(error.message));
  assert.throws(() => lint({ environment: { validateNoSetStateInRender: 'yes' } }),
    /validating environment config[\s\S]*validateNoSetStateInRender/);
});
