import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS,
} from '@varin/extension-builtins/host';
import {
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
} from '@varin/extension-builtins';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';

interface TestEvent extends Record<string, unknown> { items: Array<Record<string, unknown>>; kind?: string; resourceId?: string }
const featureValue = <Value>(result: object): Value => (result as { value: unknown }).value as Value;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <Value>(probe: () => Value | Promise<Value>, timeoutMs = 15_000): Promise<NonNullable<Value>> => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<Value>;
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  throw lastError ?? new Error('Timed out waiting for TypeScript language service');
};

describe('built-in TypeScript language extension', () => {
  it('serves a real project through the same Host authority used by extensions', async () => {
    const packageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(
      VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    );
    if (!packageRoot) throw new Error('TypeScript language extension package root is unavailable');
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    const events: TestEvent[] = [];
    try {
      const utilityContent = [
        'export function greet(name: string): string {',
        '  return `Hello ${name}`;',
        '}',
        'export const answer: number = "wrong";',
        '',
      ].join('\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['*.ts'],
      }));
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'util.ts'), utilityContent);
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'main.ts'), 'const value = gre\n');
      language.registerProvider({
        providerId: 'varin.typescript-language',
        command: process.execPath,
        args: [path.join(packageRoot, 'runtime', 'typescript-language-server.mjs'), '--stdio'],
        initializationOptions: {
          tsserver: { fallbackPath: path.join(packageRoot, 'runtime', 'typescript', 'lib', 'tsserver.js') },
        },
        languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
        source: 'builtin',
      });
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestEvent));
      const utility = harness.resource('util.ts');
      const main = harness.resource('main.ts');
      const utilitySync = await language.syncDocument({
        resource: utility,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: utilityContent,
      });
      if (utilitySync.status !== 'synced') {
        throw new Error('message' in utilitySync && typeof utilitySync.message === 'string' ? utilitySync.message : utilitySync.status);
      }
      expect(await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = gre\n',
      })).toMatchObject({ status: 'synced' });
      // didOpen is a notification. Wait for the server's first project-backed result before
      // exercising auto-import resolution, whose details depend on the completed project graph.
      const utilityDiagnostic = await waitUntil(() => events.find((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'util.ts'
        && event.items.some((item) => /string|number|assignable/i.test(String(item.message)))
      )));
      expect(utilityDiagnostic.items.length).toBeGreaterThan(0);

      const completion = await language.completion({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 17 },
      });
      expect(completion.status).toBe('ready');
      const greetCompletion = featureValue<Array<Record<string, unknown>>>(completion).find((item) => item.label === 'greet');
      if (!greetCompletion) throw new Error('Expected greet completion');
      expect(greetCompletion.resolveToken).toEqual(expect.any(String));
      const resolvedCompletion = await language.completionResolve({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: String(greetCompletion?.resolveToken ?? ''),
      });
      expect(resolvedCompletion.status, 'message' in resolvedCompletion ? resolvedCompletion.message : undefined).toBe('ready');
      const resolvedValue = featureValue<Record<string, unknown>>(resolvedCompletion);
      expect(Array.isArray(resolvedValue.additionalTextEdits) ? resolvedValue.additionalTextEdits.length : 0).toBeGreaterThan(0);

      const mainContent = "import { greet } from './util';\nconst value = greet('Varin');\n";
      await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        content: mainContent,
      });
      const position = { line: 1, character: 15 };
      expect(await language.hover({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: { contents: expect.any(Array) },
      });
      expect(await language.definition({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: [expect.objectContaining({ resource: utility })],
      });
      expect(await language.references({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: expect.arrayContaining([expect.objectContaining({ resource: utility })]),
      });
      expect(await language.workspaceSymbols({ resource: main, languageId: 'typescript', documentVersion: 2, query: 'greet' })).toMatchObject({
        status: 'ready', value: expect.arrayContaining([expect.objectContaining({ name: 'greet', resource: utility })]),
      });
      const renamed = await language.rename({
        resource: utility,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 17 },
        newName: 'welcome',
      });
      expect(renamed).toMatchObject({ status: 'ready' });
      const renameValue = featureValue<{ documentChanges: Array<{ kind: string; resource: { resourceId: string } }> }>(renamed);
      expect(new Set(renameValue.documentChanges
        .filter((change) => change.kind === 'text')
        .map((change) => change.resource.resourceId))).toEqual(new Set(['main.ts', 'util.ts']));
      expect(await language.documentFormatting({
        resource: main,
        languageId: 'typescript',
        documentVersion: 2,
        formatting: { tabSize: 2, insertSpaces: true },
      })).toMatchObject({ status: 'ready', value: expect.any(Array) });

      const missingImportContent = "const value = greet('Varin');\n";
      await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 3,
        reason: 'change',
        content: missingImportContent,
      });
      const missingImportDiagnostic = await waitUntil(() => events.findLast((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'main.ts'
        && event.items.some((item) => /greet|cannot find name/i.test(String(item.message)))
      )));
      const actions = await language.codeActions({
        resource: main,
        languageId: 'typescript',
        documentVersion: 3,
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 19 } },
        diagnostics: missingImportDiagnostic.items,
      });
      expect(actions.status).toBe('ready');
      expect(featureValue<Array<Record<string, unknown>>>(actions)
        .some((action) => action.edit || action.resolveToken || action.command)).toBe(true);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  }, 30_000);
});
