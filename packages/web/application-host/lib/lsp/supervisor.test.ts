import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from './servers.js';

type LanguageRuntime = ReturnType<typeof createLanguageSupervisor>;
interface TestLanguageEvent extends Record<string, unknown> {
  items: Array<Record<string, unknown>>;
  kind?: string;
  snapshot?: Record<string, unknown>;
}

const featureValue = <Value>(result: object): Value => {
  if (!('value' in result)) throw new Error('Expected language feature value');
  return (result as { value: unknown }).value as Value;
};
const generationOf = (status: { generation?: number }): number => typeof status.generation === 'number' ? status.generation : 0;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <Value>(probe: () => Value | Promise<Value>, timeoutMs = 8000): Promise<NonNullable<Value>> => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<Value>;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw lastError ?? new Error('Timed out waiting for language supervisor condition');
};

const fixtureProvider = (overrides: {
  env?: NodeJS.ProcessEnv;
  languageIds?: string[];
  providerId?: string;
  source?: 'builtin' | 'extension' | 'host' | 'workspace';
} = {}) => ({
  providerId: overrides.providerId ?? 'fixture',
  command: process.execPath,
  args: VARIN_LSP_FIXTURE_SERVER_ARGS,
  languageIds: overrides.languageIds ?? ['typescript'],
  source: overrides.source ?? 'host',
  ...(overrides.env ? { env: overrides.env } : {}),
});

describe('language supervisor', () => {
  it('batches filesystem invalidations and delivers them before the next language query', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({ documents: harness.authority, spawn, pathModule: path, isTrusted: async () => true });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('note.ts');
      await language.syncDocument({ resource, languageId: 'typescript', documentVersion: 1, reason: 'open', content: 'const value = 1;\n' });
      for (let repeat = 0; repeat < 4; repeat++) for (let index = 0; index < 32; index++) {
        language.observeDocumentMutation({ workspaceId: resource.workspaceId, resourceId: `generated/${index}.ts`, kind: 'modified' });
      }
      language.observeDocumentMutation({ workspaceId: resource.workspaceId, resourceId: 'generated/0.ts', kind: 'deleted' });
      const result = await language.executeCommand({ resource, languageId: 'typescript', documentVersion: 1,
        providerId: 'fixture', generation: 1, command: 'fixture.watchedFiles' });
      const batches = featureValue<Array<Array<{ uri: string; type: number }>>>(result);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(32);
      expect(batches[0]?.find(change => change.uri.endsWith('/generated/0.ts'))?.type).toBe(3);
    } finally { await language.dispose(); await harness.cleanup(); }
  });

  it('initializes a fixture server and serves completion, hover, and code actions', async () => {
    const harness = await createDocumentAuthorityHarness();
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn: (command, args, options) => {
        spawnedEnvironment = options.env;
        return spawn(command, args, options);
      },
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
      language.registerProvider(fixtureProvider({ env: { ELECTRON_RUN_AS_NODE: '0' } }));
      const resource = harness.resource('note.ts');
      const synced = await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      expect(synced.status).toBe('synced');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({
        status: 'ready',
        features: {
          completionTriggerCharacters: ['.'],
          signatureHelpTriggerCharacters: ['(', ','],
          onTypeFormattingTriggerCharacters: ['}', ';'],
        },
      });
      expect(spawnedEnvironment?.ELECTRON_RUN_AS_NODE).toBe('1');
      const completion = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(completion).toMatchObject({
        status: 'ready',
        providerId: 'fixture',
        generation: 1,
        value: [{
          label: 'fixtureItem',
          insertTextFormat: 'snippet',
          detail: 'fixture',
          documentation: { kind: 'markdown', value: '**fixture completion**' },
          textEdit: { newText: 'fixtureItem(${1:value})' },
          additionalTextEdits: [{ newText: 'import { fixtureItem } from "fixture";\n' }],
        }],
      });
      const resolvedCompletion = await language.completionResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: String(featureValue<Array<Record<string, unknown>>>(completion)[0]?.resolveToken ?? ''),
      });
      expect(resolvedCompletion).toMatchObject({
        status: 'ready',
        value: { detail: 'resolved fixture', documentation: { kind: 'markdown', value: '**resolved**' } },
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({
        status: 'ready',
        value: { contents: [{ kind: 'markdown', value: 'fixture-hover' }] },
      });
      const signature = await language.signatureHelp({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 1 },
      });
      expect(signature).toMatchObject({
        status: 'ready',
        value: { signatures: [{ label: 'fixtureItem(value: string): void' }] },
      });
      const actions = await language.codeActions({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
      expect(actions).toMatchObject({
        status: 'ready',
        value: [{ title: 'Fixture action', isPreferred: true, edit: { documentChanges: [{ kind: 'text' }] } }],
      });
      const resolvedAction = await language.codeActionResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: String(featureValue<Array<Record<string, unknown>>>(actions)[0]?.resolveToken ?? ''),
      });
      expect(resolvedAction).toMatchObject({
        status: 'ready',
        value: { command: { command: 'fixture.finish', arguments: ['done'] } },
      });
      expect(await language.executeCommand({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        providerId: 'fixture',
        generation: 1,
        command: 'fixture.finish',
        arguments: ['done'],
      })).toMatchObject({ status: 'ready', value: { finished: 'done' } });
      expect(await language.executeCommand({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        providerId: 'fixture',
        generation: 1,
        command: 'fixture.not-declared',
      })).toMatchObject({ status: 'failed', reason: 'unsupported' });
      const releaseCommand = language.retainWorkspace(resource.workspaceId);
      await language.syncDocument({ resource, languageId: 'typescript', documentVersion: 1, reason: 'close' });
      expect(await language.executeCommand({ resource, languageId: 'typescript', providerId: 'fixture', generation: 1,
        command: 'fixture.finish', arguments: ['after-delete'] })).toMatchObject({ status: 'ready', value: { finished: 'after-delete' } });
      expect(await language.executeCommand({ resource, languageId: 'typescript', providerId: 'fixture', generation: 0,
        command: 'fixture.finish' })).toMatchObject({ status: 'stale' });
      releaseCommand();
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('drops stale diagnostics and completions for a newer document version', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events: TestLanguageEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestLanguageEvent));
      const resource = harness.resource('stale.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 4,
        reason: 'open',
        content: 'FIXTURE_STALE_DIAG\n',
      });
      await wait(200);
      expect(events.some((event) => event.kind === 'diagnostics' && event.items.length > 0)).toBe(false);
      const stale = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 9,
        position: { line: 0, character: 0 },
      });
      expect(stale).toMatchObject({ status: 'stale', documentVersion: 4, providerId: 'fixture', generation: 1 });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('activates workspace language extensions on demand and stops after the last document closes', async () => {
    const harness = await createDocumentAuthorityHarness();
    let activations = 0;
    const holder: { language?: LanguageRuntime } = {};
    const language = createLanguageSupervisor({
      activateProviders: async () => {
        activations += 1;
        holder.language?.registerProvider(fixtureProvider());
      },
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    holder.language = language;
    try {
      const resource = harness.resource('lazy.ts');
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const lazy = true;\n',
      })).toMatchObject({ status: 'synced', generation: 1 });
      expect(activations).toBe(1);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('ready');
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'close',
      })).toMatchObject({ status: 'synced', generation: 1 });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('isolates the editor view from the Host view and lets each own its documents', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('shared.ts');
      // The editor holds an unsaved buffer while the Host view is bound to the
      // committed text of the same file.
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 4,
        reason: 'open',
        content: 'const buffer = "unsaved";\n',
      })).toMatchObject({ status: 'synced' });
      const hostSync = await language.syncDocument({
        view: 'agent',
        resource,
        languageId: 'typescript',
        reason: 'open',
        content: 'const disk = true;\n',
        contentRevision: 'disk-r1',
      });
      // The Host view assigns its own version instead of borrowing the editor's.
      expect(hostSync).toMatchObject({ status: 'synced', documentVersion: 1, contentRevision: 'disk-r1' });
      expect(language.syncedDocumentVersion(harness.identity.workspaceId, 'typescript', resource.resourceId)).toBe(4);
      expect(language.syncedContentRevision(harness.identity.workspaceId, 'typescript', resource.resourceId)).toBe('disk-r1');
      expect(language.inspectViews().map((view) => view.view).toSorted()).toEqual(['agent', 'surface']);

      // Re-binding the same text neither notifies nor bumps the version.
      expect(await language.syncDocument({
        view: 'agent',
        resource,
        languageId: 'typescript',
        reason: 'open',
        content: 'const disk = true;\n',
        contentRevision: 'disk-r1',
      })).toMatchObject({ documentVersion: 1 });

      // An answer bound to a superseded revision is stale, not silently mixed.
      expect(await language.hover({
        view: 'agent',
        resource,
        languageId: 'typescript',
        expectedRevision: 'disk-r0',
        position: { line: 0, character: 1 },
      })).toMatchObject({ status: 'stale', reason: 'revision', contentRevision: 'disk-r1' });
      expect(await language.hover({
        view: 'agent',
        resource,
        languageId: 'typescript',
        expectedRevision: 'disk-r1',
        position: { line: 0, character: 1 },
      })).toMatchObject({ status: 'ready', contentRevision: 'disk-r1' });

      // Closing the editor's last tab must not cancel the agent's view.
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 4,
        reason: 'close',
      })).toMatchObject({ status: 'synced' });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript', 'agent').status).toBe('ready');
      expect(await language.hover({
        view: 'agent',
        resource,
        languageId: 'typescript',
        expectedRevision: 'disk-r1',
        position: { line: 0, character: 1 },
      })).toMatchObject({ status: 'ready' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('bounds the Host view open documents and releases the view when it goes idle', async () => {
    const harness = await createDocumentAuthorityHarness();
    let clock = 1_000;
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
      hostViewDocumentLimit: 2,
      hostViewIdleMs: 500,
      now: () => clock,
    });
    try {
      language.registerProvider(fixtureProvider());
      for (const name of ['a.ts', 'b.ts', 'c.ts']) {
        clock += 10;
        expect(await language.syncDocument({
          view: 'agent',
          resource: harness.resource(name),
          languageId: 'typescript',
          reason: 'open',
          content: `const ${name.replace('.ts', '')} = true;\n`,
          contentRevision: `disk-${name}`,
        })).toMatchObject({ status: 'synced' });
      }
      expect(language.inspectViews()).toEqual([expect.objectContaining({ view: 'agent', openDocuments: 2 })]);
      expect(language.syncedContentRevision(harness.identity.workspaceId, 'typescript', 'a.ts')).toBeNull();
      expect(language.syncedContentRevision(harness.identity.workspaceId, 'typescript', 'c.ts')).toBe('disk-c.ts');

      clock += 501;
      await language.releaseIdleHostViews();
      expect(language.inspectViews()).toEqual([]);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript', 'agent').status).toBe('absent');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('keeps an activation failure distinct from an absent provider', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      activateProviders: async () => { throw new Error('extension activation failed'); },
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      expect(await language.syncDocument({
        resource: harness.resource('failed.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const failed = true;\n',
      })).toMatchObject({ status: 'failed', message: 'extension activation failed' });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({
        status: 'failed',
        message: 'extension activation failed',
      });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('maps navigation, symbols, formatting, semantic, inlay, link, and color contracts', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('rich.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'open',
        content: 'fixture\nchild\nend\n',
      });
      const point = { line: 0, character: 1 };
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } };

      expect(await language.definition({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready',
        value: [{ resource, targetRange: { end: { character: 8 } }, targetSelectionRange: { end: { character: 7 } }, originSelectionRange: { end: { character: 3 } } }],
      });
      expect(await language.references({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready', value: [{ resource }],
      });
      expect(await language.documentSymbols({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ name: 'fixtureSymbol', children: [{ name: 'fixtureChild' }] }],
      });
      expect(await language.rename({ resource, languageId: 'typescript', documentVersion: 2, position: point, newName: 'renamed' })).toMatchObject({
        status: 'ready', value: { documentChanges: [{ kind: 'text', resource, edits: [{ newText: 'renamed' }] }] },
      });
      expect(await language.documentFormatting({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        formatting: { tabSize: 2, insertSpaces: true },
      })).toMatchObject({ status: 'ready', value: [{ newText: 'formatted' }] });
      expect(await language.semanticTokens({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready',
        value: {
          data: [0, 0, 7, 0, 1],
          resultId: 'fixture-semantic-1',
          legend: { tokenTypes: ['variable'], tokenModifiers: ['readonly'] },
        },
      });
      const hints = await language.inlayHints({ resource, languageId: 'typescript', documentVersion: 2, range });
      expect(hints).toMatchObject({ status: 'ready', value: [{ label: ': string', kind: 'type' }] });
      const resolvedHint = await language.inlayHintResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        resolveToken: String(featureValue<Array<Record<string, unknown>>>(hints)[0]?.resolveToken ?? ''),
      });
      expect(resolvedHint).toMatchObject({ status: 'ready', value: { paddingLeft: true, tooltip: { value: 'Resolved fixture hint' } } });
      expect(await language.documentHighlights({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready', value: [{ kind: 'read' }],
      });
      expect(await language.foldingRanges({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ startLine: 0, endLine: 2, kind: 'region' }],
      });
      expect(await language.selectionRanges({ resource, languageId: 'typescript', documentVersion: 2, positions: [point] })).toMatchObject({
        status: 'ready', value: [{ parent: { range: { end: { character: 8 } } } }],
      });
      const links = await language.documentLinks({ resource, languageId: 'typescript', documentVersion: 2 });
      expect(links).toMatchObject({ status: 'ready', value: [{ tooltip: 'Fixture link' }] });
      expect(await language.documentLinkResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        resolveToken: String(featureValue<Array<Record<string, unknown>>>(links)[0]?.resolveToken ?? ''),
      })).toMatchObject({ status: 'ready', value: { target: { kind: 'uri', uri: 'https://example.com/fixture' } } });
      expect(await language.documentColors({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }],
      });
      expect(await language.colorPresentations({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        range,
        color: { red: 1, green: 0.5, blue: 0, alpha: 1 },
      })).toMatchObject({ status: 'ready', value: [{ label: '#ff8000', textEdit: { newText: '#ff8000' } }] });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('returns typed unsupported without degrading a provider that omitted a capability', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider({ env: { VARIN_LSP_FIXTURE_MINIMAL: '1' } }));
      const resource = harness.resource('unsupported.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'fixture\n',
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({
        status: 'failed',
        reason: 'unsupported',
        providerId: 'fixture',
        generation: 1,
      });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({ status: 'ready' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('applies multiple incremental edits against the same document version', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events: TestLanguageEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestLanguageEvent));
      const resource = harness.resource('incremental.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'xFIXTURE_ERROXy',
      });
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        changes: [
          { from: 0, to: 1, insert: '' },
          { from: 13, to: 15, insert: 'R' },
        ],
      });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'incremental.ts'
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 2)
      )));
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('publishes versioned diagnostics and isolates a crashed language session', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider({ providerId: 'crash', languageIds: ['typescript'], env: { VARIN_LSP_FIXTURE_CRASH: '1' } }));
      language.registerProvider(fixtureProvider({ providerId: 'python', languageIds: ['python'], env: { VARIN_LSP_FIXTURE_CRASH: '' } }));
      const events: TestLanguageEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestLanguageEvent));
      await language.syncDocument({
        resource: harness.resource('ok.py'),
        languageId: 'python',
        documentVersion: 1,
        reason: 'open',
        content: 'FIXTURE_ERROR\n',
      });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'ok.py'
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 1)
      )));
      await language.syncDocument({
        resource: harness.resource('boom.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const x = 1;\n',
      });
      await waitUntil(() => language.getStatus(harness.identity.workspaceId, 'typescript').status === 'failed');
      expect(language.getStatus(harness.identity.workspaceId, 'python').status).toBe('ready');
      const hover = await language.hover({
        resource: harness.resource('ok.py'),
        languageId: 'python',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover.status).toBe('ready');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('refuses project-provided commands in untrusted workspaces without spawning', async () => {
    const harness = await createDocumentAuthorityHarness();
    let spawned = 0;
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn: (...args) => {
        spawned += 1;
        return spawn(...args);
      },
      pathModule: path,
      isTrusted: async () => false,
    });
    try {
      language.registerProvider(fixtureProvider({ source: 'workspace' }));
      const result = await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      expect(result.status).toBe('failed');
      expect('message' in result ? result.message : '').toMatch(/Untrusted workspace/i);
      expect(spawned).toBe(0);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('failed');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('marks a live session degraded when a feature request fails', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('hover.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'FIXTURE_HOVER_FAIL\n',
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover.status).toBe('failed');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('degraded');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('increments generation after disposeWorkspace', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events: TestLanguageEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestLanguageEvent));
      await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      const first = language.getStatus(harness.identity.workspaceId, 'typescript');
      expect(first.status).toBe('ready');
      events.length = 0;
      await language.disposeWorkspace(harness.identity.workspaceId);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'diagnostics',
          resourceId: 'note.ts',
          providerId: 'fixture',
          generation: first.generation,
          items: [],
        }),
        expect.objectContaining({
          kind: 'status',
          snapshot: expect.objectContaining({
            status: 'absent',
            providerId: 'fixture',
            generation: first.generation,
          }),
        }),
      ]));
      await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      const second = language.getStatus(harness.identity.workspaceId, 'typescript');
      expect(second.status).toBe('ready');
      expect(generationOf(second)).toBeGreaterThan(generationOf(first));
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('reopens the current in-memory buffer before serving a replacement provider generation', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events: TestLanguageEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestLanguageEvent));
      const resource = harness.resource('generation.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const clean = true;\n',
      });
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        content: 'FIXTURE_ERROR\n',
      });
      const first = language.getStatus(harness.identity.workspaceId, 'typescript');
      language.registerProvider(fixtureProvider());
      events.length = 0;

      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ status: 'ready', generation: generationOf(first) + 1 });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'generation.ts'
        && event.generation === generationOf(first) + 1
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 2)
      )));
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('serves call hierarchy with session-scoped item tokens', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const a = harness.resource('a.ts');
      const b = harness.resource('b.ts');
      await language.syncDocument({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'export function targetFn() { return 1; }\nexport const callerA = () => targetFn();\n',
      });
      await language.syncDocument({
        resource: b,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'export const callerB = targetFn();\n',
      });
      const prepared = await language.prepareCallHierarchy({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 16 },
      });
      expect(prepared.status).toBe('ready');
      const items = featureValue<Array<Record<string, unknown>>>(prepared);
      expect(items[0]).toMatchObject({
        name: 'targetFn',
        resource: { resourceId: 'a.ts' },
      });
      const itemToken = items[0]?.itemToken;
      expect(typeof itemToken).toBe('string');

      const incoming = await language.callHierarchyIncoming({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        itemToken: itemToken as string,
      });
      expect(incoming.status).toBe('ready');
      const calls = featureValue<Array<{ from: Record<string, unknown>; fromRanges: unknown[] }>>(incoming);
      // Sites in both synced files call `targetFn(` — the declaration itself
      // is not a call into it.
      expect(calls.some((call) => (call.from.resource as { resourceId: string }).resourceId === 'a.ts')).toBe(true);
      expect(calls.some((call) => (call.from.resource as { resourceId: string }).resourceId === 'b.ts')).toBe(true);
      expect(calls.every((call) => call.fromRanges.length > 0)).toBe(true);

      const outgoing = await language.callHierarchyOutgoing({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        itemToken: itemToken as string,
      });
      expect(outgoing.status).toBe('ready');
      const made = featureValue<Array<{ to: Record<string, unknown> }>>(outgoing);
      // a.ts makes no calls to other names — outgoing is genuinely empty.
      expect(made).toEqual([]);

      // A token from an earlier prepare is cleared by the next one.
      const second = await language.prepareCallHierarchy({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 1, character: 26 },
      });
      expect(second.status).toBe('ready');
      const stale = await language.callHierarchyIncoming({
        resource: a,
        languageId: 'typescript',
        documentVersion: 1,
        itemToken: itemToken as string,
      });
      expect(stale).toMatchObject({ status: 'failed', reason: 'stale-item' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('reports call hierarchy unsupported when the provider lacks the capability', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      // The minimal fixture advertises no callHierarchyProvider.
      language.registerProvider(fixtureProvider({ env: { VARIN_LSP_FIXTURE_MINIMAL: '1' } }));
      const resource = harness.resource('a.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'export function targetFn() { return 1; }\n',
      });
      const prepared = await language.prepareCallHierarchy({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 16 },
      });
      expect(prepared).toMatchObject({ status: 'failed', reason: 'unsupported' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });
});
