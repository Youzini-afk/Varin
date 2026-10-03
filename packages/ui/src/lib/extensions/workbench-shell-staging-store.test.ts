import { expect, test } from 'vitest';
import type { SurfaceContribution } from '@varin/extension-surface';
import { VARIN_WORKBENCH_SHELL_DATA_CONTRACT } from '@varin/extension-contract';
import {
  getWorkbenchShellStagingRequest,
  mountWorkbenchShellStagingHost,
  settleWorkbenchShellStagingFailure,
  settleWorkbenchShellStagingReady,
  stageWorkbenchShellRender,
} from './workbench-shell-staging-store';

const contribution = (): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: {
        web: { replacementTargets: [], slots: [] },
      },
    },
    id: 'dev.example.shell.main',
    kind: 'shell',
    replacement: { target: 'workbench.shell' },
    supports: ['web'],
  },
  implementation: { render: () => 'ready' },
  owner: {
    desiredRevision: 1,
    entrypointId: 'main',
    extensionId: 'dev.example.shell',
    extensionVersion: '1.0.0',
    generation: 1,
    hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
    realmId: 'surface',
  },
});

test('render staging refuses to hang when no Shell host is mounted', async () => {
  await expect(stageWorkbenchShellRender(contribution(), { target: 'workbench.shell' }))
    .rejects.toThrow('staging host is unavailable');
});

test('render staging keeps the candidate published until promotion releases it', async () => {
  const unmount = mountWorkbenchShellStagingHost();
  const pending = stageWorkbenchShellRender(contribution(), { target: 'workbench.shell' });
  const request = getWorkbenchShellStagingRequest();
  expect(request).not.toBeNull();
  settleWorkbenchShellStagingReady(request!);
  const handle = await pending;
  expect(getWorkbenchShellStagingRequest()).toBe(request);
  await handle.dispose();
  expect(getWorkbenchShellStagingRequest()).toBeNull();
  unmount();
});

test('render staging rejects a candidate that fails during render', async () => {
  const unmount = mountWorkbenchShellStagingHost();
  const pending = stageWorkbenchShellRender(contribution(), { target: 'workbench.shell' });
  const request = getWorkbenchShellStagingRequest();
  settleWorkbenchShellStagingFailure(request!, new Error('render failed'));
  await expect(pending).rejects.toThrow('render failed');
  unmount();
});
