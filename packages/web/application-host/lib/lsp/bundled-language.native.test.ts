import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID } from '@varin/extension-builtins';
import { VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS } from '@varin/extension-builtins/host';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createNativeProcessTestHarness, hasNativeProcessKernel } from '../process/native-process.test-helper.js';
import { createLanguageSupervisor } from './supervisor.js';

if (!hasNativeProcessKernel && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Bundled language acceptance needs the release kernel');

it.skipIf(!hasNativeProcessKernel)('serves real Python symbols and type diagnostics through Host and Rust process pipes', async () => {
  const packageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID);
  if (!packageRoot) throw new Error('Build the bundled language extension before running acceptance');
  const harness = await createDocumentAuthorityHarness();
  const native = createNativeProcessTestHarness(harness.authority);
  const { service } = await native.get();
  const language = createLanguageSupervisor({ documents: harness.authority, spawn: service.spawn });
  const diagnostics: unknown[] = [];
  const content = 'def greet(name: str) -> str:\n    return name\n\nvalue: int = greet("Varin")\n';
  try {
    await fs.writeFile(path.join(harness.workspaceRoot, 'hello.py'), content);
    language.registerProvider({ providerId: 'varin.python-language', command: process.execPath, args: [path.join(packageRoot, 'runtime/pyright-langserver.cjs'), '--stdio'], languageIds: ['python'], source: 'builtin' });
    language.subscribe(harness.identity.workspaceId, (event) => {
      const value = event as { kind?: string; items?: unknown[] };
      if (value.kind === 'diagnostics') diagnostics.push(...value.items ?? []);
    });
    const request = { resource: harness.resource('hello.py'), languageId: 'python', documentVersion: 1 };
    expect(await language.syncDocument({ ...request, content, reason: 'open' })).toMatchObject({ status: 'synced' });
    expect(await language.documentSymbols(request)).toMatchObject({ status: 'ready', value: expect.arrayContaining([expect.objectContaining({ name: 'greet' })]) });
    await vi.waitFor(() => expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/str.*int|assignable/i) })])), { timeout: 15_000 });
    await language.dispose();
    expect((await service.list(harness.workspaceRoot)).every((process) => !process.writerActive)).toBe(true);
  } finally { await language.dispose(); await native.dispose(); await harness.cleanup(); }
}, 30_000);
