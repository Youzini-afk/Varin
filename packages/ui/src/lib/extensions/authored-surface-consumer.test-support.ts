import { SurfaceExtensionRuntime } from '@varin/extension-surface';
import { SurfaceExtensionLoader, type SurfaceExtensionHost } from '@varin/extension-loader';
import { createWorkbenchCompositionHost } from './workbench-composition-host.js';

/** Minimal DOM implementation for the authored package's real framework-neutral mount/disposer. */
export type AuthoredPanelTestElement = HTMLElement & { children: AuthoredPanelTestElement[] };

export const createAuthoredPanelTestContainer = (): AuthoredPanelTestElement => {
  const document = {} as Document;
  const makeElement = (): AuthoredPanelTestElement => {
    const children: AuthoredPanelTestElement[] = [];
    let parent: AuthoredPanelTestElement | undefined;
    const element = {
      children, dataset: {}, style: {}, className: '', textContent: '', hidden: false, ownerDocument: document,
      appendChild(child: AuthoredPanelTestElement & { setParent(parent: AuthoredPanelTestElement): void }) {
        child.remove(); children.push(child); child.setParent(element as AuthoredPanelTestElement); return child;
      },
      setParent(value: AuthoredPanelTestElement) { parent = value; },
      remove() {
        if (!parent) return;
        const index = parent.children.indexOf(element as AuthoredPanelTestElement);
        if (index >= 0) parent.children.splice(index, 1);
        parent = undefined;
      },
      addEventListener() {}, removeEventListener() {},
    } as unknown as AuthoredPanelTestElement;
    return element;
  };
  document.createElement = (() => makeElement()) as Document['createElement'];
  return makeElement();
};

/** No Host implementation or listener fixture: all catalog and artifact reads use the supplied API. */
export const createAuthoredPanelConsumer = async (host: SurfaceExtensionHost) => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const styles: Array<{ committed: boolean; disposed: boolean; cssText: string; ownerLabel: string }> = [];
  const errors: unknown[] = [];
  const loader = new SurfaceExtensionLoader({
    host, realmId: 'authored-panel-consumer', surface: 'web', surfaceRuntime: runtime,
    styleHost: { stage: (cssText, ownerLabel) => {
      const record = { committed: false, disposed: false, cssText, ownerLabel };
      styles.push(record);
      return { commit: () => { record.committed = true; }, dispose: () => { record.disposed = true; } };
    } },
  });
  const container = createAuthoredPanelTestContainer();
  const workbench = createWorkbenchCompositionHost({
    shellContributionId: 'test.authored-shell',
    owner: { desiredRevision: 1, entrypointId: 'shell', extensionId: 'test.authored-shell', extensionVersion: '1.0.0',
      generation: 1, hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a', realmId: 'authored-test-shell' },
    allowedReplacementTargets: new Set(), allowedSlots: new Set(['workbench.secondary.after']),
    activate: async () => undefined, resolveReplacement: () => undefined,
    resolveSlotCandidates: (slot, _kind, preview) => (preview?.visibleContributions ?? runtime.getSnapshot().visibleContributions)
      .filter((contribution) => contribution.descriptor.placement?.slot === slot),
    registerContributionConsumer: runtime.registerContributionConsumer,
    subscribe: runtime.subscribe,
    onError: (error) => { errors.push(error); },
  });
  await workbench.mountSlot({ container, slot: 'workbench.secondary.after' });
  return {
    container, errors, loader, runtime, styles,
    start: async () => { await loader.start(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    reconcile: async () => { await loader.reconcile(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    close: async () => { await workbench.dispose('Window closed'); await loader.stop(); },
  };
};
