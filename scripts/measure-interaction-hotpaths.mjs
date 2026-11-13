#!/usr/bin/env node
// Same harness can load either checkout. Fixtures never touch user workspaces.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const output = process.argv[3];
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const samples = 15;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, medianMs: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], minMs: sorted[0], maxMs: sorted.at(-1) };
};
const timed = async work => { const start = performance.now(); await work(); return performance.now() - start; };
const { createDocumentAuthorityHarness } = await load('packages/web/application-host/lib/documents/contract-fixtures.ts');
const { revisionFromBytes } = await load('packages/web/application-host/lib/documents/inspect.ts');
const h = await createDocumentAuthorityHarness();
const documents = [];
try {
  for (const repetitions of [256, 32768, 262144]) {
    const body = 'Varin 保存与读取: preserve bytes, line endings, BOM.\r\n'.repeat(repetitions);
    const bodies = [body + '0', body + '1'];
    const bytes = bodies.map(text => Buffer.from('\ufeff' + text));
    const revisions = bytes.map(revisionFromBytes);
    const resource = h.resource('benchmark.txt');
    await fs.writeFile(path.join(h.workspaceRoot, resource.resourceId), bytes[0]);
    let revision = revisions[0];
    const timings = [];
    const OriginalDecoder = globalThis.TextDecoder;
    let decodes = 0;
    globalThis.TextDecoder = class extends OriginalDecoder { decode(...args) { decodes += 1; return super.decode(...args); } };
    try {
      for (let index = 0; index < samples + 1; index += 1) {
        const next = (index + 1) % 2;
        const elapsed = await timed(async () => {
          const result = await h.authority.write({ token: h.token(), resource, content: bodies[next], encoding: 'utf-8', bom: true, expectedRevision: revision });
          assert.equal(result.status, 'written'); assert.equal(result.revision, revisions[next]);
          assert.equal(result.byteLength, bytes[next].length); revision = result.revision;
        });
        if (index > 0) timings.push(elapsed);
      }
    } finally { globalThis.TextDecoder = OriginalDecoder; }
    const read = await h.authority.read(resource);
    assert.equal(read.status, 'ready'); assert.equal(read.content, bodies[samples % 2 === 0 ? 1 : 0]);
    assert.equal(read.bom, true); assert.equal(read.revision, revision);
    documents.push({ bytes: bytes[0].length, sha256: createHash('sha256').update(bytes[0]).digest('hex'), fullTextDecodesIncludingWarmup: decodes, ...stats(timings) });
  }
} finally { await h.cleanup(); }

const { AgentRuntimeClient } = await load('packages/web/application-host/lib/kernel/agent-runtime-client.ts');
const { ThreadAdapter } = await load('packages/web/application-host/lib/kernel/thread-adapter.ts');
const identity = { runtime: 'agent', threadId: 'thread:measurement', branchId: 'branch:measurement' };
const run = { id: 'run:measurement', thread_id: identity.threadId, branch_id: identity.branchId, state: 'failed', revision: 2, epoch: 1, configuration: {}, waiting_on: null, cancel_requested: false };
const thread = { thread_id: identity.threadId, principal_id: null, parent_thread_id: null, observer_project_ids: [], branches: [{ branch_id: identity.branchId, active_run_id: null, head: 'history:199', latest_run: run }] };
const retained = Array.from({ length: 200 }, (_, index) => ({ id: `history:${index}`, thread_id: identity.threadId, run_id: run.id,
  parent: index ? `history:${index - 1}` : null, source: index % 2 ? 'tool' : 'user',
  content: { text: `Original history ${index}: retained 中文 bytes`, content: index % 2 ? { kind: 'tool_result', result: { completion: { kind: 'job_accepted', operation_id: `op:${index}` } } } : { kind: 'text', text: 'User message' } }, provider: null }));
const window = retained.slice(-20);
const visibleOperations = window.filter(item => item.source === 'tool').map(item => ({ id: `op:${item.id.split(':')[1]}`, run_id: run.id, phase: 'terminal', outcome: 'succeeded', effect: 'confirmed' }));
const failure = { runId: run.id, cursor: 42, code: 'fixture', message: 'Controlled fixture' };
const emptyDirectory = { rootThreadId: identity.threadId, members: [], nextCursor: null };
const view = { identity, eventCursor: 42, thread, activeRun: null, runFailure: failure, history: window,
  historyPage: { head: 'history:199', previous: 'history:180' }, inputs: [], operations: visibleOperations,
  context: { checkpoint: null, jobs: [] }, followups: [], goals: [], children: [], childExecutions: [], childDirectory: emptyDirectory,
  childActivity: {}, delegatedExecutions: [], launch: null, modelSelection: { desired: null, active: null }, policySelection: null };
const calls = new Map();
const runtime = new AgentRuntimeClient({ subscribeExit() { return () => {}; }, onToolReleased() {}, isRunDriverInvoking() { return true; }, async agentRuntimeRequest(method, params) {
  calls.set(method, (calls.get(method) ?? 0) + 1);
  switch (method) {
    case 'runtime.thread.view': return structuredClone(view);
    case 'runtime.thread.inspect': return thread;
    case 'runtime.status': return { eventCursor: 42 };
    case 'runtime.history.page': return { head: 'history:199', previous: 'history:180', items: window.map(({content, provider, ...item}) => ({...item, content_ref:`content:${item.id}`})) };
    case 'runtime.history.body': {
      const item = retained.find(item => item.id === params.itemId);
      const bytes = Buffer.from(JSON.stringify({ content: item.content, provider: item.provider }));
      return { itemId: item.id, contentRef: `content:${item.id}`, chunkIndex: 0, chunkCount: 1, totalBytes: bytes.length, bytesBase64: bytes.toString('base64') };
    }
    case 'runtime.context.inspect': case 'runtime.launch.inspect': case 'runtime.child.for_thread': return null;
    case 'runtime.model.inspect': return { desired: null, active: null };
    case 'runtime.family.list': return emptyDirectory;
    case 'runtime.run.failure': return failure;
    case 'runtime.operation.inspect': return visibleOperations.find(operation => operation.id === params.operationId);
    case 'runtime.run.inspect': return run;
    default: return [];
  }
} });
const adapter = new ThreadAdapter(runtime, { async resolveModel() { throw Error('not used'); }, async rebindModel() { throw Error('not used'); } }, async () => {}, () => {});
const snapshot = await adapter.snapshot(identity);
assert.equal(snapshot.runFailure.runId, run.id); assert.equal(snapshot.eventCursor, 42);
assert.deepEqual(snapshot.history, window); assert.deepEqual(snapshot.children, []);
assert.deepEqual(snapshot.operations, visibleOperations);
const { projectUiEmbeds } = await load('packages/ui/src/lib/interactive-ui/embed-projection.ts');
const history = Array.from({ length: 200 }, (_, index) => ({ id: `history:${index}`, type: 'message', timestamp: '', parentId: null,
  message: { id: `history:${index}`, role: 'assistant', api: '', provider: '', model: '', stopReason: 'stop', timestamp: 0,
    content: [{ id: `text:${index}`, type: 'text', text: ('Retained conversation 中文, with the same visible content.\n').repeat(128)
      + '```varin-ui\n' + JSON.stringify({ type: 'embed', ref: `ui:report-${index}@1` }) + '\n```' }] } }));
const expectedEmbeds = projectUiEmbeds(history, {});
const embedSamples = [];
for (let sample = 0; sample < samples; sample++) {
  embedSamples.push(await timed(async () => {
    for (let frame = 0; frame < 20; frame++) {
      const live = { id: 'progress', role: 'assistant', api: '', model: '', provider: '', stopReason: 'pending', timestamp: 0,
        content: [{ type: 'text', text: 'Current response '.repeat(frame + 1) }] };
      assert.deepEqual(projectUiEmbeds(history, {}, live), expectedEmbeds);
    }
  }));
}
const embedProjection = { historyMessages: history.length, historyUtf8Bytes: history.reduce((total, entry) => total + Buffer.byteLength(entry.message.content[0].text), 0),
  streamingFramesPerSample: 20, outputSha256: createHash('sha256').update(JSON.stringify(expectedEmbeds)).digest('hex'), ...stats(embedSamples) };
const sourceFiles = [
  'packages/web/application-host/lib/documents/authority.ts', 'packages/web/application-host/lib/documents/inspect.ts',
  'packages/web/application-host/lib/kernel/thread-adapter.ts', 'packages/ui/src/lib/interactive-ui/embed-projection.ts',
];
const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async relative => [relative,
  createHash('sha256').update(await fs.readFile(path.join(source, relative))).digest('hex')])));
const report = { schema: 1, source, sourceSha256, scriptSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['diff', '--stat'], { cwd: source, encoding: 'utf8' }).trim()), node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, documents, embedProjection, snapshot: { retainedHistory: retained.length, visibleHistory: window.length, visibleToolReceipts: visibleOperations.length, outputSha256: createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex'), nativeRequests: [...calls.values()].reduce((a, b) => a + b, 0), requestsByMethod: Object.fromEntries(calls) }, limitations: [
  'Document measurements run the actual Host authority, local file I/O, hashing and atomic rename, with synthetic mixed UTF-8/CRLF/BOM files. Native durable storage is not bound in this harness; these numbers do not measure fsync, recovery journaling or end-to-end desktop save latency.',
  'Each size excludes one warmup; p95 uses the nearest-rank definition over 15 warm samples. OS caches are not flushed. Sizes run sequentially in an isolated temporary workspace.',
  'Embed projection measures the actual frontend parser/placement function over retained message objects and changing stream frames; it excludes React, DOM layout and paint. Each sample includes 20 frames and output equality checks.',
  'Snapshot measurements count real adapter-to-runtime requests with a synthetic native port. They measure eliminated Host work, not Rust storage, network or provider latency.'
] };
const json = JSON.stringify(report, null, 2) + '\n';
if (output) { await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true }); await fs.writeFile(output, json); }
console.log(json);
