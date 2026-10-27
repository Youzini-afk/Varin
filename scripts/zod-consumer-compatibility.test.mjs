import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = createRequire(new URL('../package.json', import.meta.url));
const web = createRequire(new URL('../packages/web/package.json', import.meta.url));
const { Client, InMemoryTransport, parseJSONRPCMessage } = web('@modelcontextprotocol/client');
const { ESLint } = root('eslint');

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
