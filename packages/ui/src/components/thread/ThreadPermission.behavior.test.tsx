import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Operation } from '@varin/protocol';
import { ThreadPermission } from './ThreadPermission';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: React.ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} /> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('shows exact settings scope and preserves one original permission decision through repeated clicks', async () => {
  const permission = { id: 'permission', decision: null, call: { name: 'settings_action', arguments: { id: 'providers.connect', verb: 'patch' } },
    scope: { reason: 'new credential destination', persistent: { tool: 'settings_action', scope: 'targets', available: true,
      targets: [{ tool: 'settings_action', authority: 'model-credentials:destination', label: 'Credential destination for account: https://new.example' }] } } };
  const operation = { id: 'original', phase: 'waiting', cancel_requested: false, result: { kind: 'control', value: { permission } } } as unknown as Operation;
  let finish!: (operation: Operation) => void;
  const decide = vi.fn(() => new Promise<Operation>(resolve => { finish = resolve; }));
  await act(async () => root.render(<ThreadPermission operation={operation} enabled onDecide={decide} />));
  expect(container.textContent).toContain('chat.permission.targetScope');
  expect(container.textContent).toContain('Credential destination for account: https://new.example');
  const always = [...container.querySelectorAll('button')].find(button => button.textContent === 'chat.permission.always')!;
  await act(async () => { always.click(); always.click(); });
  expect(decide).toHaveBeenCalledExactlyOnceWith('permission', 'allow_always');
  await act(async () => finish({ ...operation, result: { kind: 'control', value: { permission: { ...permission, decision: 'allow_once', persisted_rule: [{ authority: 'model-credentials:destination' }] } } } } as unknown as Operation));
  expect(container.textContent).toContain('chat.permission.saved');
  expect(container.querySelectorAll('button')).toHaveLength(0);
});

it('shows every message field before a mandatory one-time decision', async () => {
  const permission = { id: 'send-permission', decision: null,
    call: { name: 'gmail_send', arguments: { to: ['one@example.test'], subject: 'Meeting', body: 'Original message' } },
    scope: { reason: 'Review and confirm this action before it runs.', confirmation: 'always', previewLabels: { to: '收件人 / To', subject: '主题 / Subject', body: '正文 / Message' } } };
  const operation = { id: 'send', phase: 'waiting', cancel_requested: false,
    result: { kind: 'control', value: { permission } } } as unknown as Operation;
  const decide = vi.fn().mockResolvedValue(operation);
  await act(async () => root.render(<ThreadPermission operation={operation} enabled onDecide={decide} />));
  const preview = container.querySelector('dl.thread-permission-preview');
  expect(preview?.textContent).toContain('收件人 / To');
  expect(preview?.textContent).toContain('one@example.test');
  expect(preview?.textContent).toContain('Meeting');
  expect(preview?.textContent).toContain('Original message');
  expect(preview?.closest('details')).toBeNull();
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'chat.permission.always')).toBe(false);
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'chat.permission.once')!.click(); });
  expect(decide).toHaveBeenCalledExactlyOnceWith('send-permission', 'allow_once');
});
