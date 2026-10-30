import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VARIN_TRANSITION_SCENE_DATA_CONTRACT, VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE } from '@varin/extension-contract';
import {
  beginWorkbenchProfileTransition, getWorkbenchProfileTransitionSnapshot,
  resetWorkbenchProfileTransitionForTests, revealWorkbenchProfileTransition,
  type WorkbenchTransitionSceneController,
} from '@/lib/workbench/profile-transition';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';
import { WorkbenchTransitionOverlay } from './WorkbenchTransitionOverlay';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/extensions/workbench-transition-scene', () => ({
  holdWorkbenchTransitionSceneContribution: () => ({ descriptor: { id: 'scene' } }),
}));
vi.mock('@/lib/extensions/workbench-registry', async () => {
  const React = await import('react');
  // A stable extension subtree must receive phases through its own controller subscription.
  const Scene = React.memo(({ transition }: { transition: WorkbenchTransitionSceneController }) => {
    const frame = React.useSyncExternalStore(transition.subscribe, transition.getSnapshot);
    return <div data-phase={frame.phase} data-transition={frame.transitionId} />;
  });
  return {
    useSurfaceRegistrySnapshot: () => ({}),
    workbenchContributionInstanceKey: () => 'scene',
    WorkbenchSurfaceContributionHost: ({ props, onMountReady }: { props: { transition: WorkbenchTransitionSceneController }; onMountReady(): void }) => {
      React.useEffect(onMountReady, [onMountReady]);
      return <Scene {...props} />;
    },
  };
});

const scene: WorkbenchTransitionSceneCapture = {
  contributionId: 'scene', desiredRevision: 1, entrypointId: 'main', extensionId: 'motion',
  extensionVersion: '1.0.0', generation: 1, hostId: 'host', realmId: 'surface',
  data: { contract: VARIN_TRANSITION_SCENE_DATA_CONTRACT, scenes: [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE],
    durations: { [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
      covering: { quick: 10, standard: 10, reduced: 0 }, revealing: { quick: 20, standard: 20, reduced: 0 },
    } } },
};
let root: Root;
let host: HTMLElement;
let retirements: Array<{ finish(): void; cancel: ReturnType<typeof vi.fn> }>;
beforeEach(async () => {
  vi.useFakeTimers(); resetWorkbenchProfileTransitionForTests();
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(0), 0);
  window.cancelAnimationFrame = handle => window.clearTimeout(handle);
  retirements = [];
  window.HTMLElement.prototype.animate = () => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cancel = vi.fn(); retirements.push({ finish, cancel });
    return { finished, cancel } as unknown as Animation;
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<WorkbenchTransitionOverlay />));
});
afterEach(async () => { await act(async () => root.unmount()); resetWorkbenchProfileTransitionForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

test('delivers phases to the mounted scene and safely replaces an unfinished retirement', async () => {
  let first!: number;
  await act(async () => { first = beginWorkbenchProfileTransition({ scene, toProfileId: 'bot' }); });
  await advance(10);
  expect(host.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('covered');
  let previousReveal!: Promise<void>;
  await act(async () => { previousReveal = revealWorkbenchProfileTransition(first); });
  expect(host.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('revealing');
  await advance(20);
  const previousLayer = host.querySelector('[data-varin-transition-scene]');
  const staleRetirement = retirements[0]!;

  let second!: number;
  await act(async () => { second = beginWorkbenchProfileTransition({ scene, toProfileId: 'workbench' }); });
  await previousReveal;
  expect(staleRetirement.cancel).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-varin-transition-scene]')).not.toBe(previousLayer);
  await act(async () => staleRetirement.finish());
  expect(host.querySelector('[data-transition]')?.getAttribute('data-transition')).toBe(String(second));
  await advance(10);
  expect(host.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('covered');
  let reveal!: Promise<void>;
  await act(async () => { reveal = revealWorkbenchProfileTransition(second); });
  await advance(20);
  await act(async () => retirements.at(-1)!.finish());
  await reveal;
  await advance(0);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  expect(host.querySelector('[data-varin-transition-scene]')).toBeNull();
});

test('recovering the page does not replay a transition whose scene host left', async () => {
  await act(async () => { beginWorkbenchProfileTransition({ scene, toProfileId: 'workbench' }); });
  await advance(10);
  expect(host.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('covered');
  await act(async () => root.render(null));
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  await act(async () => root.render(<WorkbenchTransitionOverlay />));
  await advance(100);
  expect(host.querySelector('[data-varin-transition-scene]')).toBeNull();
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});
