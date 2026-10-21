import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID } from '@varin/extension-builtins';
import { VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS } from '@varin/extension-builtins/host';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createNativeProcessTestHarness, hasNativeProcessKernel } from '../process/native-process.test-helper.js';
import { createLanguageSupervisor } from './supervisor.js';
import { createLanguageOwner } from '../kernel/language-owner.js';
import { runKernelCompute } from '../kernel/compute-runner.js';

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

const rustAnalyzer = process.env.VARIN_TEST_RUST_ANALYZER;
it.skipIf(!hasNativeProcessKernel || !rustAnalyzer)('resolves Rust definitions inside a nested Cargo project through native source discovery and pipes', async () => {
  const harness = await createDocumentAuthorityHarness();
  const native = createNativeProcessTestHarness(harness.authority);
  const { service, client } = await native.get();
  const workspaceId = harness.identity.workspaceId;
  const scoped = client.scoped(await client.issueGrant({ grantId: 'rust-project-probe', owningWorkspace: workspaceId,
    executionWorkspace: workspaceId, pathScopes: [''], capabilities: ['storage.read', 'storage.write'] }));
  const root = await scoped.fileRootRegister({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: harness.workspaceRoot });
  const language = createLanguageSupervisor({ documents: harness.authority, spawn: service.spawn, spawnAdmitted: service.spawnAdmitted });
  const owner = createLanguageOwner({ documents: harness.authority, supervisor: language, sources: {
    validateLanguage: async () => {}, dispose: async () => {},
    prepareLanguageView: async () => ({ root: harness.workspaceRoot, check: async () => {}, release: async () => {} }),
    processAdmission: () => async () => ({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: harness.workspaceRoot }),
    compute: (_query, input, options) => runKernelCompute(scoped, { ...input, workspaceId, rootId: root.rootId }, options),
    read: async (_query, resourceId, signal) => {
      const snapshot = await harness.authority.readSnapshot({ workspaceId, resourceId }, { signal });
      return snapshot.status === 'ready' ? { status: 'ready', content: snapshot.content, revision: snapshot.revision, source: 'disk' }
        : { status: 'unavailable', message: snapshot.status };
    },
  } });
  try {
    await fs.mkdir(path.join(harness.workspaceRoot, 'project', 'src'), { recursive: true });
    await fs.writeFile(path.join(harness.workspaceRoot, 'project', 'Cargo.toml'), '[package]\nname = "varin_language_probe"\nversion = "0.1.0"\nedition = "2021"\n');
    await fs.writeFile(path.join(harness.workspaceRoot, 'project', 'src', 'lib.rs'), 'pub fn target() -> u32 { 7 }\npub fn caller() -> u32 { target() }\n');
    language.registerProvider({ providerId: 'varin.managed.rust', command: rustAnalyzer!, languageIds: ['rust'], source: 'builtin' });
    const liveRoot = { hostId: 'fixture', rootId: root.rootId, canonicalRoot: harness.workspaceRoot };
    await vi.waitFor(async () => {
      const result = await owner({ runId: 'rust-probe', threadId: 'rust-probe', grantId: 'rust-project-probe',
        source: { resource_owner: { kind: 'local' }, workspace_id: workspaceId, execution_workspace_id: workspaceId,
          mode: 'live_root', branch_id: null, revision: null, live_root: liveRoot }, physicalRoot: liveRoot,
        method: 'definition', path: 'project/src/lib.rs', line: 1, character: 26 }, new AbortController().signal);
      expect(result).toMatchObject({ status: 'ready', items: [expect.objectContaining({
        resource: harness.resource('project/src/lib.rs'), targetSelectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } },
      })] });
    }, { timeout: 30_000, interval: 500 });
  } finally { await language.dispose(); await native.dispose(); await harness.cleanup(); }
}, 45_000);
