import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ desktop: true, platform: 'darwin', fullscreen: false, tablet: false,
  query: vi.fn<() => Promise<boolean>>() }));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => shell.desktop,
  getDesktopPlatform: () => shell.platform,
  usesFramelessDesktopChrome: () => shell.desktop && ['win32', 'linux'].includes(shell.platform),
  invokeDesktop: () => shell.query(),
}));
vi.mock('@/lib/device', () => ({ useTabletStandalonePwaRuntime: () => shell.tablet }));
import { useTitlebarLeftInset } from './useTitlebarLeftInset';

let root: Root;
let container: HTMLElement;
function Titlebar({ padding }: { padding?: string }) {
  const inset = useTitlebarLeftInset(padding);
  return <header style={{ paddingLeft: inset }}><button>IDE</button></header>;
}
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  shell.desktop = true; shell.platform = 'darwin'; shell.fullscreen = false; shell.tablet = false;
  shell.query.mockReset().mockImplementation(async () => shell.fullscreen);
  container = window.document.getElementById('root')! as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const inset = () => container.querySelector('header')!.style.paddingLeft;

it('reserves native controls on a cold mount and follows fullscreen without another workbench', async () => {
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('5.5rem');
  shell.fullscreen = true;
  await act(async () => window.dispatchEvent(new window.Event('varin:window-resized')));
  expect(inset()).toBe('0.75rem');
  shell.fullscreen = false;
  await act(async () => window.dispatchEvent(new window.Event('varin:window-resized')));
  expect(inset()).toBe('5.5rem');
  await act(async () => root.render(null));
  const calls = shell.query.mock.calls.length;
  window.dispatchEvent(new window.Event('varin:window-resized'));
  expect(shell.query).toHaveBeenCalledTimes(calls);
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('5.5rem');
});

it('keeps browser and frameless desktop controls in their own overlay geometry', async () => {
  shell.desktop = false;
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('calc(0.75rem + var(--varin-wco-left-inset, 0px))');
  expect(shell.query).not.toHaveBeenCalled();
  shell.desktop = true; shell.platform = 'win32';
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('calc(0.75rem + var(--varin-wco-left-inset, 0px))');
  expect(shell.query).not.toHaveBeenCalled();
  await act(async () => root.render(<Titlebar padding="0.5rem" />));
  expect(inset()).toBe('calc(0.5rem + var(--varin-wco-left-inset, 0px))');
});

it('retains tablet standalone safe space and does not overlap controls when the shell query is unavailable', async () => {
  shell.desktop = false; shell.tablet = true;
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('max(calc(0.75rem + var(--varin-wco-left-inset, 0px)), 5.5rem)');
  shell.desktop = true; shell.tablet = false;
  shell.query.mockRejectedValueOnce(new Error('shell unavailable'));
  await act(async () => root.render(<Titlebar />));
  expect(inset()).toBe('5.5rem');
});
