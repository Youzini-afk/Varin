import { expect, it } from 'vitest';
import { WEB_TOOL_DECLARATIONS, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import type { PiSettingsSnapshot } from '@varin/protocol';
import { createDocumentReader } from '../harness/document-reading.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createWebRuntime, type WebRuntimeOptions } from './web-runtime.js';

it('freezes Web configuration failures at its own declarations and preserves the accepted configuration', async () => {
  const { materials } = createMaterialStoreFixture();
  const unused = async (): Promise<never> => { throw new Error('Configuration preparation must not execute a tool'); };
  const make = (settings: WebRuntimeOptions['settings']) => createWebRuntime({
    runtime: { familyList: unused, run: unused, launch: unused },
    materials, documentReader: createDocumentReader({ materials }),
    webFetch: createWebFetch({ ssrf: { check: unused, isSameHost: () => false }, materials }),
    fetch: unused, readAuth: unused, settings,
  });
  const snapshot: PiSettingsSnapshot = { global: { harness: { web: { domains: { block: ['blocked.example'] } } } },
    project: {}, globalRevision: 'accepted', projectRevision: 'unselected', projectTrusted: false };
  const run = { runId: 'run', threadId: 'thread', source: null };
  const accepted = await make(async source => { expect(source).toBeNull(); return snapshot; }).prepareConfiguration(run, []);
  const original = accepted(WEB_TOOL_DECLARATIONS[1]);
  expect(JSON.parse(original!).web.settings.domains.block).toEqual(['blocked.example']);
  const failure = new Error('Settings file is unreadable');
  const broken = await make(async () => { throw failure; }).prepareConfiguration(run, [], () => 'other-owner');
  expect(broken(COMPUTER_TOOL_DECLARATIONS[0])).toBe('other-owner');
  expect(() => broken(WEB_TOOL_DECLARATIONS[1])).toThrow(failure);
  expect(broken(WEB_TOOL_DECLARATIONS[1], original)).toBe(original);
});
