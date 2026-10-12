import { describe, expect, test } from 'vitest';
import { VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@varin/extension-builtins';
import { VARIN_WORKBENCH_REPLACEMENT_TARGETS } from '@varin/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@varin/extension-surface';
import {
  findCapturedWorkbenchTransitionScene,
  holdWorkbenchTransitionSceneContribution,
  resolveWorkbenchTransitionScene,
} from './workbench-transition-scene';

const descriptor = VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.contributions?.[0];
if (!descriptor) throw new Error('Built-in transition scene descriptor is unavailable');

const contribution = (generation = 1): SurfaceContribution => ({
  descriptor,
  implementation: { framework: 'test' },
  owner: {
    desiredRevision: 1,
    entrypointId: 'main',
    extensionId: VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.id,
    extensionVersion: VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.version,
    generation,
    hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
    realmId: 'transition-scene-test',
  },
});

const snapshot = (contributions: SurfaceContribution[]): SurfaceRegistrySnapshot => ({
  actual: [],
  contributions,
  layoutReferences: [],
  replacementSelections: {},
  revision: 1,
  services: [],
  visibleContributions: contributions,
});

describe('Workbench Transition Scene selection', () => {
  test('uses the one declared fallback only when the target Profile has no explicit selection', () => {
    const fallback = contribution();
    const resolved = resolveWorkbenchTransitionScene(snapshot([fallback]), {});
    expect(resolved.status).toBe('ready');
    expect(resolved.scene?.contributionId).toBe(descriptor.id);
  });

  test('retains an explicit missing selection instead of silently choosing another scene', () => {
    const resolved = resolveWorkbenchTransitionScene(snapshot([contribution()]), {
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition]: 'dev.example.missing.transition',
    });
    expect(resolved).toEqual({ contribution: null, scene: null, status: 'missing' });
  });

  test('captures the complete owner generation and rejects a replacement generation mid-transition', () => {
    const first = contribution(3);
    const resolved = resolveWorkbenchTransitionScene(snapshot([first]), {});
    expect(resolved.status).toBe('ready');
    expect(findCapturedWorkbenchTransitionScene(snapshot([first]), resolved.scene)).toBe(first);
    expect(findCapturedWorkbenchTransitionScene(snapshot([contribution(4)]), resolved.scene)).toBeUndefined();
  });

  test('reports malformed scene data as failure rather than an empty catalog', () => {
    const malformed: SurfaceContribution = {
      ...contribution(),
      descriptor: { ...descriptor, data: { fallback: true } },
    };
    const resolved = resolveWorkbenchTransitionScene(snapshot([malformed]), {});
    expect(resolved.status).toBe('failed');
    expect(resolved.scene).toBeNull();
  });
});


/**
 * The mounted scene has to survive the commit it is covering.
 *
 * Re-resolving against the live registry on every render meant one missed match swapped the scene for the
 * Core fallback and back, and remounting a scene restarts every animation in it from its first frame. In the
 * middle of a reveal that reads as the cover snapping shut again and the logo fading back in, at whatever
 * moment the registry happened to settle — which is why it only ever showed up sometimes.
 */
describe('holding the mounted Transition Scene', () => {
  test('resolves once from the registry', () => {
    const mounted = contribution();
    const resolved = resolveWorkbenchTransitionScene(snapshot([mounted]), {});
    expect(resolved.status).toBe('ready');

    expect(holdWorkbenchTransitionSceneContribution({
      capture: resolved.scene,
      held: undefined,
      snapshot: snapshot([mounted]),
    })).toBe(mounted);
  });

  test('keeps the mounted scene when the owner generation moves on', () => {
    const mounted = contribution();
    const resolved = resolveWorkbenchTransitionScene(snapshot([mounted]), {});

    // A regenerated owner no longer matches the capture, which is exactly what the commit produces.
    const regenerated = snapshot([contribution(4)]);
    expect(findCapturedWorkbenchTransitionScene(regenerated, resolved.scene)).toBeUndefined();
    expect(holdWorkbenchTransitionSceneContribution({
      capture: resolved.scene,
      held: mounted,
      snapshot: regenerated,
    })).toBe(mounted);
  });

  test('keeps the mounted scene when the registry empties entirely', () => {
    const mounted = contribution();
    const resolved = resolveWorkbenchTransitionScene(snapshot([mounted]), {});

    expect(holdWorkbenchTransitionSceneContribution({
      capture: resolved.scene,
      held: mounted,
      snapshot: snapshot([]),
    })).toBe(mounted);
  });

  test('a transaction that never resolved one still reports none, so Core can cover instead', () => {
    expect(holdWorkbenchTransitionSceneContribution({
      capture: null,
      held: undefined,
      snapshot: snapshot([contribution()]),
    })).toBeUndefined();
  });
});
