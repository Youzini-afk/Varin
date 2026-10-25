import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';
import { parseRoute } from './parseRoute';
import { updateBrowserURL, type AppRouteState } from './serializeRoute';

const state: AppRouteState = {
  threadId: 'thread:review', branchId: 'branch:main', tab: 'chat',
  isSettingsOpen: false, settingsPath: '', diffFile: null,
};
const installWindow = (href: string) => {
  const history = { state: { scroll: 37 }, pushState: vi.fn(), replaceState: vi.fn() };
  vi.stubGlobal('window', { location: new URL(href), history });
  return history;
};
beforeEach(() => resetEmbeddedSessionChatCache());
afterEach(() => vi.unstubAllGlobals());

test('reads native Thread identity and a one-time directory hint, treating blank values as absent', () => {
  expect(parseRoute(new URLSearchParams({ thread: ' thread:review ', branch: 'branch:main', directory: ' D:/work ', tab: 'diff' })))
    .toMatchObject({ threadId: state.threadId, branchId: state.branchId, directory: 'D:/work', tab: 'diff' });
  expect(parseRoute(new URLSearchParams('thread=%20&directory=%20')))
    .toMatchObject({ threadId: null, directory: null });
});

test('writes a revisitable Thread/branch URL without carrying the one-time directory hint forward', () => {
  const history = installWindow('https://app.test/app?directory=%2Fone-time');
  updateBrowserURL(state);
  expect(history.pushState).toHaveBeenCalledTimes(1);
  const url = new URL(history.pushState.mock.calls[0]![2], window.location.href);
  expect(parseRoute(url.searchParams)).toMatchObject({ threadId: state.threadId, branchId: state.branchId, directory: null });
  expect(history.replaceState).not.toHaveBeenCalled();

  updateBrowserURL({ ...state, isSettingsOpen: true, settingsPath: 'extensions' }, { replace: true });
  const [saved, , written] = history.replaceState.mock.calls[0]!;
  expect(saved.scroll).toBe(37);
  expect(parseRoute(new URL(written, window.location.href).searchParams)).toMatchObject({ settingsPath: 'extensions', tab: null });
});

test('does not rewrite an embedded conversation identity, even for a forced navigation', () => {
  const history = installWindow('https://app.test/app?panel=session-chat&threadId=child&branchId=main&readOnly=1');
  updateBrowserURL(state, { force: true, replace: true });
  expect(history.pushState).not.toHaveBeenCalled();
  expect(history.replaceState).not.toHaveBeenCalled();
});
