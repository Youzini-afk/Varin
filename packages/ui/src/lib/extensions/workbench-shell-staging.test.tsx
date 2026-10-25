import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SurfaceContribution } from '@varin/extension-surface';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { WorkbenchShellStagingHost } from './workbench-shell-staging';
import { stageWorkbenchShellRender } from './workbench-shell-staging-store';
import { registerLazyWorkbenchShell } from '@/workbenches/register-shells';
import { resolveWorkbenchShellComponent, retryWorkbenchShellLoad } from './shell-component-registry';

vi.mock('./workbench-registry', () => ({
  workbenchContributionInstanceKey: (c: SurfaceContribution) => `${c.descriptor.id}:${c.owner.generation}`,
  WorkbenchSurfaceContributionHost: ({ contribution, onMountReady }: {
    contribution: SurfaceContribution; onMountReady(): void;
  }) => {
    const Component = (contribution.implementation as { Component: React.ComponentType }).Component;
    React.useEffect(onMountReady, [onMountReady]);
    return <Component />;
  },
}));

let root: Root, container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const contribution = (id: string, Component: React.ComponentType) => ({
  descriptor: { id }, owner: { generation: 1 }, implementation: { Component },
}) as unknown as SurfaceContribution;

it('promotes the prepared subtree without remounting or losing local state, then releases the previous Shell', async () => {
  const mount = vi.fn(), unmount = vi.fn(), activate = vi.fn(), oldRelease = vi.fn();
  const Candidate = () => {
    const active = useWorkbenchShellActive();
    const [value, setValue] = React.useState(0);
    React.useEffect(() => { mount(); return unmount; }, []);
    React.useEffect(() => { if (active) activate(); }, [active]);
    const profile = useWorkbenchProfileId();
    return <button data-profile={profile} onClick={() => setValue(v => v + 1)}>{value}</button>;
  };
  const Previous = () => { React.useEffect(() => oldRelease, []); return <span>previous</span>; };
  const previous = contribution('previous', Previous), next = contribution('next', Candidate);
  const ready = vi.fn();
  const render = (selected: SurfaceContribution) => root.render(<WorkbenchShellStagingHost
    contribution={selected} profileId="selected" fallback="loading" errorFallback={() => 'failed'} onMountReady={ready} />);
  await act(async () => render(previous));
  let staging!: ReturnType<typeof stageWorkbenchShellRender>;
  await act(async () => { staging = stageWorkbenchShellRender(next, { target: 'workbench.shell' }, 'selected'); });
  const handle = await staging;
  const button = container.querySelector('button')!;
  expect(button.dataset.profile).toBe('selected');
  await act(async () => button.click());
  expect(activate).not.toHaveBeenCalled();
  expect(container.textContent).toContain('previous');
  await act(async () => render(next));
  await handle.promote?.();
  await act(async () => handle.dispose());
  expect(container.querySelector('button')).toBe(button);
  expect(button.textContent).toBe('1');
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(oldRelease).toHaveBeenCalledTimes(1);
  expect(button.closest('[inert]')).toBeNull();
});

it('registers lazy Shells without loading them, and a suspended candidate keeps the active Shell visible', async () => {
  let resolve!: (value: { default: React.ComponentType<Record<string, unknown>> }) => void;
  const load = vi.fn(() => new Promise<{ default: React.ComponentType<Record<string, unknown>> }>(r => { resolve = r; }));
  const unused = vi.fn();
  registerLazyWorkbenchShell('test.lazy', load);
  registerLazyWorkbenchShell('test.unused', unused);
  expect(load).not.toHaveBeenCalled(); expect(unused).not.toHaveBeenCalled();
  const previous = contribution('previous', () => <span>previous</span>);
  const next = contribution('lazy', resolveWorkbenchShellComponent('test.lazy')!);
  await act(async () => root.render(<WorkbenchShellStagingHost contribution={previous}
    fallback="loading" errorFallback={() => 'failed'} onMountReady={() => {}} />));
  let staging!: ReturnType<typeof stageWorkbenchShellRender>;
  await act(async () => { staging = stageWorkbenchShellRender(next, {}); });
  expect(container.textContent).toContain('previous');
  expect(load).toHaveBeenCalledTimes(1); expect(unused).not.toHaveBeenCalled();
  let settled = false; void staging.then(() => { settled = true; });
  expect(settled).toBe(false);
  await act(async () => { resolve({ default: () => <span>candidate</span> }); });
  const handle = await staging;
  expect(container.textContent).toContain('candidate');
  await act(async () => handle.dispose());
  expect(container.textContent).toBe('previous');
});

it('a failed lazy load stays failed until an explicit retry', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('chunk unavailable'))
    .mockResolvedValueOnce({ default: () => <span>loaded</span> });
  registerLazyWorkbenchShell('test.retry', load);
  const Shell = resolveWorkbenchShellComponent('test.retry')!;
  class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? <button onClick={() => {
      retryWorkbenchShellLoad('test.retry'); this.setState({ failed: false });
    }}>retry</button> : this.props.children; }
  }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<Boundary><React.Suspense fallback="loading"><Shell /></React.Suspense></Boundary>));
    expect(container.textContent).toBe('retry');
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toBe('loaded');
    expect(load).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});
