import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatErrorBoundary } from './ChatErrorBoundary';
import { copyTextToClipboard } from '@/lib/clipboard';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _variant, ...props }: React.ComponentProps<'button'> & { variant?: string }) => <button {...props}>{children}</button> }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(copyTextToClipboard).mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Scene({ failure }: { failure?: Error }) {
  if (failure) throw failure;
  return <p>Conversation ready</p>;
}
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;

test('retry remounts the failed scene and keeps a recurring failure visible', async () => {
  const failure = new TypeError("Cannot read properties of undefined (reading 'test-property')");
  const render = (error?: Error) => root.render(<ChatErrorBoundary sessionId="original-thread"><Scene failure={error} /></ChatErrorBoundary>);
  await act(async () => render(failure));
  expect(container.textContent).toContain('chat.errorBoundary.title');
  await act(async () => button('chat.errorBoundary.resetAction').click());
  expect(container.textContent).toContain(failure.message);
  await act(async () => render());
  expect(container.textContent).toContain('chat.errorBoundary.title');
  await act(async () => button('chat.errorBoundary.resetAction').click());
  expect(container.textContent).toBe('Conversation ready');
});

test('changing conversation identity releases an old error without remounting healthy scene updates', async () => {
  const mounts = vi.fn();
  function HealthyScene() { React.useEffect(() => { mounts(); }, []); return <p>Healthy scene</p>; }
  const render = (key: string, children: React.ReactNode) => root.render(<ChatErrorBoundary sessionId="same-thread" resetKey={key}>{children}</ChatErrorBoundary>);
  await act(async () => render('host-a:branch-a', <Scene failure={new Error('old scope failure')} />));
  await act(async () => render('host-a:branch-b', <HealthyScene />));
  expect(container.textContent).toBe('Healthy scene');
  expect(mounts).toHaveBeenCalledOnce();
  await act(async () => render('host-b:branch-b', <HealthyScene />));
  expect(mounts).toHaveBeenCalledOnce();
});

test('shows and copies the full original error and component stacks', async () => {
  const failure = new TypeError("Cannot read properties of undefined (reading 'the-complete-property-name')");
  failure.stack = `${failure}\n    at failingRenderer (renderer.js:123:45)`;
  await act(async () => root.render(<ChatErrorBoundary sessionId="original-thread"><Scene failure={failure} /></ChatErrorBoundary>));
  const details = container.querySelector('pre')!.textContent!;
  expect(details).toContain(failure.stack);
  expect(details).toContain('errorBoundary.state.componentStackLabel');
  expect(details).toContain('Scene');
  await act(async () => button('errorBoundary.actions.copy').click());
  expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(details);
  expect(button('errorBoundary.actions.copied')).toBeDefined();
});
