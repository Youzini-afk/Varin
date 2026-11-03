/** Disposable real Application Host / controlled provider processes. No private
 * Catalog writes, alternate runtime, browser mocks, or renderer-store injection. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export const providerDisclosure = 'Controlled deterministic local SSE provider; measures the real Host/Rust/UI pipeline, not real model quality, throughput, latency, or network performance.';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function seedPrompt(turn) {
  return `VARIN_BENCHMARK_SEED:${turn}\n` + Array.from({ length: 12 }, (_, i) => `Synthetic research note ${turn}.${i}: compare the original owner, accepted input, committed result, resource lifetime, and reproducible evidence. 中文与 café 🧪.\n`).join('');
}
export function seedAnswer(turn) {
  return `Synthetic answer ${turn}.\n\n` + Array.from({ length: 6 }, (_, i) => `Section ${i + 1}: preserve the original Thread identity and observe the committed result.\n`).join('') + '\n```js\nconst evidence = { owner: "original", state: "completed" };\n```\n';
}
export const streamAnswer = Array.from({ length: 256 }, (_, i) => `Observation ${i}: the same real product receives this deterministic SSE text, renders Markdown, preserves scroll position, and retains normal animation.\n`).join('') + '\nVARIN_BENCHMARK_STREAM_COMPLETE';
function userText(body) {
  const input = body.input ?? body.messages ?? [];
  if (typeof input === 'string') return input;
  const users = input.filter(item => item.role === 'user');
  const last = users.at(-1);
  if (typeof last?.content === 'string') return last.content;
  return (last?.content ?? []).filter(part => ['input_text', 'text'].includes(part.type)).map(part => part.text ?? '').join('\n');
}
export function responseRecipe(body, nodePath = process.execPath) {
  const text = userText(body), seed = /VARIN_BENCHMARK_SEED:(\d+)/u.exec(text);
  if (seed) return { text: seedAnswer(Number(seed[1])), delayMs: 0, chunkBytes: 4096 };
  if (text.includes('VARIN_BENCHMARK_CANCEL')) return { text: streamAnswer.repeat(8), delayMs: 40, chunkBytes: 48 };
  if (text.includes('VARIN_BENCHMARK_LOCAL_PROCESS')) {
    const input = body.input ?? [], latest = input.findLastIndex(item => item.role === 'user');
    const current = input.slice(latest + 1), spawned = current.some(item => item.type === 'function_call' && item.name === 'process_spawn');
    if (!spawned) return { tool: { name: 'process_spawn', arguments: { cwd: '', command: nodePath, args: ['benchmark-workload.mjs', ...(text.includes('VARIN_BENCHMARK_LOCAL_PROCESS_HOLD') ? ['--hold'] : [])], mode: 'pipe' } } };
    return { text: 'VARIN_BENCHMARK_PROCESS_DISPATCHED. Inspect the original process owner for completion and stop evidence.', delayMs: 0, chunkBytes: 4096 };
  }
  return text.includes('VARIN_BENCHMARK_STREAM')
    ? { text: streamAnswer, delayMs: 24, chunkBytes: 96 }
    : { text: 'Synthetic controlled-provider response. No external model was contacted.', delayMs: 0, chunkBytes: 4096 };
}
export async function writeResponsesStream(response, recipe, { serial = 1, sleep = delay } = {}) {
  const id = `benchmark-response-${serial}`, itemId = `benchmark-message-${serial}`;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => { if (!response.destroyed && !response.writableEnded) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
  event('response.created', { response: { id, status: 'in_progress', output: [] } });
  if (recipe.tool) {
    event('response.completed', { response: { id, status: 'completed', output: [{ id: itemId, type: 'function_call', call_id: `benchmark-call-${serial}`, name: recipe.tool.name, arguments: JSON.stringify(recipe.tool.arguments) }] } });
  } else {
    const content = { type: 'output_text', text: recipe.text, annotations: [] };
    event('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { ...content, text: '' } });
    for (let offset = 0; offset < recipe.text.length; offset += recipe.chunkBytes) {
      if (response.destroyed || response.writableEnded) return { state: 'cancelled', bytes: offset };
      event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: recipe.text.slice(offset, offset + recipe.chunkBytes) });
      if (recipe.delayMs) await sleep(recipe.delayMs);
    }
    event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: recipe.text });
    event('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: content });
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [content] };
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1024, output_tokens: Math.ceil(recipe.text.length / 4), total_tokens: 1024 + Math.ceil(recipe.text.length / 4) } } });
  }
  if (!response.destroyed) response.end();
  return { state: 'completed', bytes: recipe.text?.length ?? 0 };
}
export async function boundedBody(request, limit = 16 * 1024 * 1024) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new Error('Controlled fixture request exceeds its explicit test budget'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function siteHtml(authenticated = false) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Varin synthetic browser fixture</title><style>body{font:18px system-ui;margin:20px;max-width:700px}label,input,button,a{display:block;margin:8px 0;padding:4px}button,a{cursor:pointer}#scroll-content{height:120px;overflow:auto;background:linear-gradient(#eef,#ffe)}</style><body data-varin-browser-fixture="true" data-authenticated="${authenticated}"><h1>Synthetic same-page browser test</h1>
  <form id="login-form" ${authenticated ? 'hidden' : ''}><label>Name<input id="login-name" name="name" autocomplete="off" required></label><label>Passphrase<input id="login-password" name="password" type="password" autocomplete="off" required></label><button id="login-submit">Log in</button></form>
  <section id="authenticated-panel" ${authenticated ? '' : 'hidden'}><p id="login-result">Synthetic login completed</p><form id="upload-form"><label>Fixture file<input id="upload-input" type="file" required></label><button id="upload-submit">Upload</button></form><p id="upload-result" data-sha256="">No upload yet</p><a id="download-link" href="/download" download="benchmark-download.txt">Download synthetic file</a><p id="download-status" data-state="idle">No download requested</p></section><div id="scroll-content"><div style="height:1600px">Scroll the same original native page.</div></div>
  <script>document.querySelector('#login-form').onsubmit=async e=>{e.preventDefault();const response=await fetch('/login',{method:'POST',headers:{accept:'application/json'},body:new URLSearchParams(new FormData(e.target))});if(!response.ok)return;document.body.dataset.authenticated='true';e.target.hidden=true;document.querySelector('#authenticated-panel').hidden=false;};document.querySelector('#upload-form').onsubmit=async e=>{e.preventDefault();const file=document.querySelector('#upload-input').files[0];const response=await fetch('/upload',{method:'POST',body:file});const result=await response.json();const node=document.querySelector('#upload-result');node.dataset.sha256=result.sha256;node.textContent='Upload verified';};document.querySelector('#download-link').onclick=()=>{document.querySelector('#download-status').dataset.state='requested';};</script></body></html>`;
}

export async function startControlledService({ port = 0, nodePath = process.execPath } = {}) {
  let serial = 0, activeStreams = 0; const receipts = { responses: 0, completed: 0, cancelled: 0, logins: 0, uploads: [], downloads: 0 };
  const server = http.createServer((request, response) => { void (async () => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const body = JSON.parse((await boundedBody(request)).toString('utf8')); activeStreams++; receipts.responses++;
      try { const result = await writeResponsesStream(response, responseRecipe(body, nodePath), { serial: ++serial }); receipts[result.state]++; }
      finally { activeStreams--; }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'benchmark-model', object: 'model' }] })); return; }
    if (request.method === 'POST' && url.pathname === '/login') {
      const form = new URLSearchParams((await boundedBody(request, 4096)).toString('utf8'));
      if (form.get('name') !== 'benchmark' || form.get('password') !== 'synthetic-only') { response.writeHead(403); response.end('Only synthetic fixture credentials are accepted'); return; }
      receipts.logins++; if (request.headers.accept === 'application/json') { response.writeHead(200, { 'set-cookie': 'varin_benchmark_authenticated=1; HttpOnly; SameSite=Strict; Path=/', 'content-type': 'application/json' }); response.end('{"authenticated":true}'); return; } response.writeHead(303, { 'set-cookie': 'varin_benchmark_authenticated=1; HttpOnly; SameSite=Strict; Path=/', location: '/site' }); response.end(); return;
    }
    const authenticated = request.headers.cookie?.split(';').some(cookie => cookie.trim() === 'varin_benchmark_authenticated=1') === true;
    if (url.pathname === '/site') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(siteHtml(authenticated)); return; }
    if (url.pathname === '/upload' && request.method === 'POST' && authenticated) {
      const bytes = await boundedBody(request, 1024 * 1024), record = { bytes: bytes.length, sha256: digest(bytes) }; receipts.uploads.push(record);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(record)); return;
    }
    if (url.pathname === '/download' && authenticated) { receipts.downloads++; response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="benchmark-download.txt"' }); response.end('Varin synthetic native-browser download.\n'); return; }
    response.writeHead(404); response.end('Unknown controlled fixture endpoint');
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('Controlled fixture request failed'); }); });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, inspect: () => ({ ...structuredClone(receipts), activeStreams }), stop: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

async function runWorker() {
  let owner, initial = true;
  process.on('message', message => { void (async () => {
    if (message.command === 'start' && initial) {
      initial = false; const { configuration: config } = message;
      if (config.mode === 'provider') owner = await startControlledService(config);
      else if (config.mode === 'settings') {
        const entry = path.join(config.runtime, 'host/node_modules/@varin/web/server/desktop-settings.js');
        const { createDesktopSettingsOwner } = await import(pathToFileURL(entry).href);
        const settings = createDesktopSettingsOwner();
        for (const operation of config.operations) await settings(operation.method, operation.args);
        owner = { stop: async () => {}, inspect: () => ({ operations: config.operations.length }) };
      } else if (config.mode === 'host') {
        const entry = path.join(config.runtime, 'host/node_modules/@varin/web/server/index.js');
        const { startWebUiServer } = await import(pathToFileURL(entry).href);
        const allowed = new URL(config.providerOrigin).origin;
        // Use the original desktop transport contract, bounded to the synthetic
        // provider. No real remote API is contacted by this isolated service.
        const desktopNetworkFetch = (url, init) => {
          if (new URL(url).origin !== allowed) throw new Error('Benchmark Host network is limited to the controlled fixture provider');
          return fetch(url, init);
        };
        const host = await startWebUiServer({ port: config.port ?? 0, host: '127.0.0.1', apiOnly: true, attachSignals: false, exitOnShutdown: false, desktopNetworkFetch });
        const credentials = await host.getDesktopLocalCredentials();
        owner = { origin: `http://127.0.0.1:${host.getPort()}`, credentials, stop: () => host.stop({ exitProcess: false }), inspect: () => ({ ready: host.isReady() }) };
      } else throw new Error('Unknown fixture worker mode');
      process.send({ id: message.id, ok: true, origin: owner.origin, credentials: owner.credentials });
    } else if (message.command === 'inspect' && owner) process.send({ id: message.id, ok: true, receipt: owner.inspect() });
    else if (message.command === 'stop' && owner) { await owner.stop(); owner = null; process.send({ id: message.id, ok: true }, () => process.disconnect()); }
    else throw new Error('Fixture worker state mismatch');
  })().catch(error => { process.send?.({ id: message.id, ok: false, error: { code: error.code ?? 'fixture-worker-failed', message: 'The real isolated fixture service could not start or complete its owner operation' } }); }); });
  process.on('disconnect', () => { if (owner) void owner.stop().finally(() => { process.exitCode = 0; }); });
}
if (process.argv.includes('--fixture-worker')) await runWorker();
