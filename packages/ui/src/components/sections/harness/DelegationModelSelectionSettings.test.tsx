import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeHarnessSettings, type HarnessSettingsInput } from '@varin/protocol';
import type { ModelChannel } from '@varin/application-client';
import { patchHarnessSettings } from './harness-settings-state';
import { DelegationModelSelectionSettings } from './DelegationModelSelectionSettings';

const fixture = vi.hoisted(() => ({ channels: [] as ModelChannel[], error: null as string | null }));
vi.mock('./ConfigurationModels', () => ({ useModelChannels: () => fixture }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, disabled, onValueChange, children }: React.PropsWithChildren<{ value: string; disabled?: boolean; onValueChange(value: string): void }>) => <select data-value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, disabled, children }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => <option value={value} disabled={disabled}>{children}</option>,
}));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, ...props }: { checked: boolean; disabled?: boolean; onCheckedChange(value: boolean): void }) =>
  <button {...props} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} /> }));

let root: Root, container: HTMLElement, latest: HarnessSettingsInput;
const id = (channel: string, model: string) => JSON.stringify([channel, model]);
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('app')!; root = createRoot(container);
  fixture.error = null;
  fixture.channels = [{ id: 'one', name: 'First account', type: 'local', enabled: true, baseUrl: 'http://localhost/v1', authentication: { kind: 'none' }, parameters: {}, models: [
    { id: 'chat', name: 'Chat model', enabled: true, operations: ['chat'], reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: false } },
    { id: 'classifier', name: 'Decision model', enabled: true, operations: ['chat', 'decision'] },
    { id: 'embedding', name: 'Vectors', enabled: true, operations: ['embedding'] },
    { id: 'disabled', name: 'Disabled', enabled: false, operations: ['chat'] },
  ] }];
  fixture.channels.push({ ...fixture.channels[0]!, id: 'two', name: 'Second account', models: [fixture.channels[0]!.models[0]!] });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(initial: HarnessSettingsInput = {}) {
  function Settings() {
    const [settings, setSettings] = React.useState(initial); latest = settings;
    return <DelegationModelSelectionSettings harness={mergeHarnessSettings(settings, {})} update={patch => setSettings(previous => patchHarnessSettings(previous, patch) as HarnessSettingsInput)} />;
  }
  await act(async () => root.render(<Settings />));
}
async function select(current: string, next: string) {
  const element = [...container.querySelectorAll('select')].find(item => item.getAttribute('data-value') === current)!;
  expect(element).toBeTruthy();
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, value: next }); element.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
async function toggle() { await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click()); }

test('chooses exact channel models, keeps selector thinking independent, and clears it on model changes', async () => {
  const worker = { providerId: 'parent', modelId: 'executor', agent: { modelSettings: { thinkingLevel: 'xhigh' as const } } };
  await render({ models: { worker } });
  const enabled = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(enabled.disabled).toBe(true); expect(enabled.getAttribute('aria-checked')).toBe('false');
  expect([...container.querySelectorAll('option')].map(option => option.value)).toEqual(['__none', id('one', 'chat'), id('one', 'classifier'), id('two', 'chat')]);
  await select('__none', id('two', 'chat'));
  expect(latest.delegationModelSelection).toEqual({ model: { providerId: 'two', modelId: 'chat' } });
  expect(enabled.disabled).toBe(false);
  expect([...container.querySelectorAll('select')].at(1)?.getAttribute('data-value')).toBe('inherit');
  await select('inherit', 'high'); await toggle();
  expect(latest.delegationModelSelection).toEqual({ enabled: true, model: { providerId: 'two', modelId: 'chat' }, thinkingLevel: 'high' });
  expect(latest.models?.worker).toEqual(worker);
  await select(id('two', 'chat'), id('one', 'classifier'));
  expect(latest.delegationModelSelection).toEqual({ enabled: true, model: { providerId: 'one', modelId: 'classifier' } });
  expect(container.querySelectorAll('select')).toHaveLength(1);
  await toggle(); expect(latest.delegationModelSelection?.model).toEqual({ providerId: 'one', modelId: 'classifier' });
  await select(id('one', 'classifier'), '__none');
  expect(latest.delegationModelSelection).toEqual({ enabled: false });
});

test('retains an unavailable saved choice instead of replacing it, and allows disabling it', async () => {
  await render({ delegationModelSelection: { enabled: true, model: { providerId: 'gone', modelId: 'saved' }, thinkingLevel: 'high' } });
  expect(container.textContent).toContain('settings.delegationModelSelection.unavailable');
  expect(latest.delegationModelSelection?.model).toEqual({ providerId: 'gone', modelId: 'saved' });
  await toggle();
  expect(latest.delegationModelSelection).toEqual({ enabled: false, model: { providerId: 'gone', modelId: 'saved' }, thinkingLevel: 'high' });
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
});
