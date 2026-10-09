import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID } from '@varin/extension-builtins';
import { VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS } from '@varin/extension-builtins/host';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';
import { createLanguageSupervisor } from '../lsp/supervisor.js';
import { createNativeLanguageOwner } from './native-language-owner.js';
import { createNativeLiveSourceOwner } from './native-live-source.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { testRange } from './native-language.test-helper.js';

it('executes all three native live tools end to end through the bundled TypeScript server and records revision evidence', async () => {
  if (!process.env.VARIN_TEST_KERNEL_PATH) throw new Error('Native language acceptance requires explicit VARIN_TEST_KERNEL_PATH');
  const packageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID);
  if (!packageRoot) throw new Error('The bundled TypeScript language extension is unavailable');
  const server = path.join(packageRoot, 'runtime', 'typescript-language-server.mjs');
  const tsserver = path.join(packageRoot, 'runtime', 'typescript', 'lib', 'tsserver.js');
  await Promise.all([fs.access(server), fs.access(tsserver)]);
  const documents = await createDocumentAuthorityHarness({ hostId: 'process-consumer' });
  const native = createNativeProcessTestHarness(documents.authority);
  const { service, client } = await native.get();
  const spawn = vi.fn(service.spawn);
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn });
  const diagnosticEvents: Array<{ resourceId: string; items: Array<Record<string, unknown>>; contentRevision?: string }> = [];
  supervisor.subscribe(documents.identity.workspaceId, value => {
    const event = value as { kind?: string; resourceId: string; items: Array<Record<string, unknown>>; contentRevision?: string };
    if (event.kind === 'diagnostics' && event.resourceId === 'main.ts') diagnosticEvents.push(event);
  });
  supervisor.registerProvider({ providerId: 'varin.typescript-language', command: process.execPath,
    args: [server, '--stdio'], initializationOptions: { tsserver: { fallbackPath: tsserver } },
    languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], source: 'builtin' });
  const liveSources = createNativeLiveSourceOwner({ documents: documents.authority, kernel: client });
  const liveRoot = await liveSources.prepare(documents.identity.workspaceId, documents.identity.workspaceId, 'real-ts-thread');
  const validateSource = vi.fn(liveSources.validate);
  const owner = createNativeLanguageOwner({ documents: documents.authority, supervisor, validateSource });
  type Query = Parameters<typeof owner>[0];
  const query = (overrides: Partial<Query>): Query => ({ runId: 'real-ts-run', threadId: 'real-ts-thread',
    workspaceId: documents.identity.workspaceId, executionWorkspaceId: documents.identity.workspaceId,
    liveRoot,
    method: 'definition', path: 'main.ts', line: 1, character: 0, ...overrides });
  const invoke = (overrides: Partial<Query>) => owner(query(overrides), new AbortController().signal);
  const targetFirstLine = 'export const emoji = "😀"; export function greet(name: string): string {';
  const sourceSecondLine = 'export const emoji = "😀"; export const message: number = greet("Varin");';
  try {
    await fs.writeFile(path.join(documents.workspaceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true },
      include: ['*.ts'],
    }));
    await fs.writeFile(path.join(documents.workspaceRoot, 'util.ts'), `${targetFirstLine}\r\n  return "Hello " + name;\r\n}\r\n`);
    await fs.writeFile(path.join(documents.workspaceRoot, 'main.ts'), `import { greet } from './util';\r\n${sourceSecondLine}\r\n`);
    expect(spawn).not.toHaveBeenCalled();
    const sourceSnapshot = await documents.authority.readSnapshot(documents.resource('main.ts'));
    if (sourceSnapshot.status !== 'ready') throw new Error('Expected readable TypeScript source fixture');
    // This bundled server publishes real diagnostics without versions. Its observations may
    // be shown, but native diagnostics remain pending and never claim a verified source range.
    expect(await invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending' });
    await vi.waitFor(() => {
      expect(diagnosticEvents.at(-1)).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ code: 2322, documentVersion: null,
          message: expect.stringMatching(/string.*number|assignable/i),
          range: testRange(1, sourceSecondLine.indexOf('message'), sourceSecondLine.indexOf('message') + 7) })]) });
    }, { timeout: 15_000, interval: 100 });
    expect(diagnosticEvents.at(-1)).not.toHaveProperty('contentRevision');
    expect(await invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', diagnosticVerification: 'unversioned',
      items: expect.arrayContaining([expect.objectContaining({ code: 2322, documentVersion: null })]),
      source: { revision: sourceSnapshot.revision } });
    const definition = await invoke({ character: sourceSecondLine.indexOf('greet') });
    expect(definition).toMatchObject({ status: 'ready',
      source: { resourceId: 'main.ts', revision: sourceSnapshot.revision, view: 'agent', dependencies: 'live',
        providerId: 'varin.typescript-language' },
      omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 },
      items: [expect.objectContaining({ resource: documents.resource('util.ts'),
        targetSelectionRange: testRange(0, targetFirstLine.indexOf('greet'), targetFirstLine.indexOf('greet') + 5) })] });
    expect(definition.items[0]).not.toHaveProperty('rangeRevision', sourceSnapshot.revision);
    const references = await invoke({ method: 'references', character: sourceSecondLine.indexOf('greet') });
    expect(references).toMatchObject({ status: 'ready',
      items: expect.arrayContaining([
        expect.objectContaining({ resource: documents.resource('util.ts'),
          range: testRange(0, targetFirstLine.indexOf('greet'), targetFirstLine.indexOf('greet') + 5) }),
        expect.objectContaining({ resource: documents.resource('main.ts'),
          range: testRange(1, sourceSecondLine.indexOf('greet'), sourceSecondLine.indexOf('greet') + 5) }),
      ]) });
    {
      client.setNativeLanguageOwner(owner);
      const calls = [
        { name: 'native_language_definition', arguments: { path: 'main.ts', line: 1, character: sourceSecondLine.indexOf('greet') } },
        { name: 'native_language_references', arguments: { path: 'main.ts', line: 1, character: sourceSecondLine.indexOf('greet') } },
        { name: 'native_language_diagnostics', arguments: { path: 'main.ts' } },
      ];
      const requests: Array<Record<string, unknown>> = [];
      const outputs: Array<Record<string, unknown>> = [];
      const provider = createServer((request, response) => {
        const bytes: Buffer[] = [];
        request.on('data', chunk => bytes.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>;
          requests.push(body);
          const previous = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
          if (previous) outputs.push(JSON.parse(String(previous.output)) as Record<string, unknown>);
          const next = calls[requests.length - 1];
          const output = next ? [{ id: `item-${requests.length}`, type: 'function_call', call_id: `call-${requests.length}`,
            name: next.name, arguments: JSON.stringify(next.arguments) }]
            : [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'Real TypeScript checks complete' }] }];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
        });
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      try {
        const address = provider.address();
        if (!address || typeof address === 'string') throw new Error('Expected local fixture address');
        const runtime = new NativeRuntimeClient(client);
        const threadId = 'real-ts-native-thread', branchId = 'real-ts-native-branch';
        await runtime.createThread(threadId, branchId);
        const receipt = await runtime.submit({ key: 'real-ts-native-input', threadId, branchId, expectedHead: null,
          input: { text: 'Inspect the TypeScript project' },
          configuration: { providerFamily: 'openai-responses', model: 'local-scripted-language-fixture',
            endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true,
            configurationGeneration: 1, maxOutputTokens: 32 } });
        const grant = await client.issueGrant({ grantId: 'real-ts-native-grant', threadId, runId: receipt.run_id,
          owningWorkspace: documents.identity.workspaceId, executionWorkspace: documents.identity.workspaceId,
          capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
        const root = await client.scoped(grant).fileRootRegister({ workspaceId: documents.identity.workspaceId,
          executionWorkspaceId: documents.identity.workspaceId, canonicalRoot: documents.workspaceRoot });
        expect(root.rootId).toBe(liveRoot.rootId);
        await runtime.startRun(receipt.run_id, undefined, { grantId: grant.grantId, runId: receipt.run_id, threadId,
          workspaceId: documents.identity.workspaceId, executionWorkspaceId: documents.identity.workspaceId,
          sourceMode: 'live_root', liveRoot, rootId: liveRoot.rootId,
          enabledTools: ['language_definition', 'language_references', 'language_diagnostics'] });
        await expect.poll(async () => (await runtime.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
        expect(requests).toHaveLength(4);
        expect(outputs).toHaveLength(3);
        const targetSnapshot = await documents.authority.readSnapshot(documents.resource('util.ts'));
        if (targetSnapshot.status !== 'ready') throw new Error('Expected readable target snapshot');
        expect(outputs[0]).toMatchObject({ outcome: 'succeeded', content: { status: 'ready',
          source: { revision: sourceSnapshot.revision, dependencies: 'live' },
          items: [expect.objectContaining({ resource: documents.resource('util.ts'),
            observedRevision: targetSnapshot.revision, rangeRevision: null,
            targetSelectionRange: testRange(0, targetFirstLine.indexOf('greet'), targetFirstLine.indexOf('greet') + 5) })] } });
        expect(outputs[1]).toMatchObject({ outcome: 'succeeded', content: { status: 'ready',
          items: expect.arrayContaining([
            expect.objectContaining({ resource: documents.resource('main.ts'), observedRevision: sourceSnapshot.revision,
              rangeRevision: sourceSnapshot.revision, range: testRange(1, sourceSecondLine.indexOf('greet'), sourceSecondLine.indexOf('greet') + 5) }),
            expect.objectContaining({ resource: documents.resource('util.ts'), observedRevision: targetSnapshot.revision, rangeRevision: null }),
          ]) } });
        expect(outputs[2]).toMatchObject({ outcome: 'succeeded', content: { status: 'pending', diagnosticVerification: 'unversioned',
          items: expect.arrayContaining([expect.objectContaining({ code: 2322, observedRevision: sourceSnapshot.revision,
            rangeRevision: null, range: testRange(1, sourceSecondLine.indexOf('message'), sourceSecondLine.indexOf('message') + 7) })]),
          source: { revision: sourceSnapshot.revision, dependencies: 'live' } } });
        const history = await runtime.history(branchId);
        const historyText = JSON.stringify(history);
        for (const call of calls) expect(historyText).toContain(call.name);
        expect(historyText).toContain('Real TypeScript checks complete');
        expect(historyText).toContain(targetSnapshot.revision);
        expect(historyText).not.toContain('language-request');
        expect(historyText).not.toContain('kernelEpoch');
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      }
    }
    const changedSecondLine = sourceSecondLine.replace('message: number', 'message: string');
    const beforeChange = diagnosticEvents.length;
    const invalidated = new Promise<void>(resolve => {
      const subscription = supervisor.subscribe(documents.identity.workspaceId, value => {
        const event = value as { kind?: string; view?: string };
        if (event.kind === 'diagnostics-invalidated' && event.view === 'agent') { subscription.close(); resolve(); }
      });
    });
    await fs.writeFile(path.join(documents.workspaceRoot, 'main.ts'), `import { greet } from './util';\r\n${changedSecondLine}\r\n`);
    await invalidated;
    const updated = await documents.authority.readSnapshot(documents.resource('main.ts'));
    if (updated.status !== 'ready') throw new Error('Expected updated TypeScript source fixture');
    expect(updated.revision).not.toBe(sourceSnapshot.revision);
    expect(await invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', source: { revision: updated.revision } });
    await vi.waitFor(() => {
      expect(diagnosticEvents.length).toBeGreaterThan(beforeChange);
      expect(diagnosticEvents.at(-1)).toMatchObject({ items: [] });
    }, { timeout: 15_000, interval: 100 });
    await vi.waitFor(async () => {
      expect(await invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', diagnosticVerification: 'unversioned',
        items: [], source: { revision: updated.revision } });
    }, { timeout: 15_000, interval: 100 });
    expect(spawn).toHaveBeenCalledTimes(1);
    await supervisor.dispose();
    expect((await service.list(documents.workspaceRoot)).every(process => !process.writerActive)).toBe(true);
  } finally { await supervisor.dispose(); await native.dispose(); await documents.cleanup(); }
}, 60_000);
