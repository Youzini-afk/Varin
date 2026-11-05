import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeHarnessSettings, type HarnessSettingsInput } from '@varin/protocol';
import { patchHarnessSettings } from './harness-settings-state';
import { WebAssistanceSettings } from './WebAssistanceSettings';

vi.mock('./ConfigurationModels', () => ({ useConfigurationModels: () => ({ providers: [{ id: 'account', name: 'Decision account' }],
  modelsFor: (provider: string) => provider === 'account' ? [{ id: 'selector', name: 'Classifier' }] : [], error: null }) }));
vi.mock('./HarnessModelField', () => ({ HarnessModelField: ({ slot }: { slot: string }) => <div data-model-slot={slot} /> }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: React.PropsWithChildren<{ value: string; onValueChange(value: string): void }>) => <select data-value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, disabled, children }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => <option value={value} disabled={disabled}>{children}</option>,
}));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange(value: boolean): void }) =>
  <button {...props} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} /> }));
let root: Root, container: HTMLElement, latest: HarnessSettingsInput;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('app')!; root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(initial: HarnessSettingsInput = {}) {
  function Settings() {
    const [settings, setSettings] = React.useState(initial); latest = settings;
    return <WebAssistanceSettings harness={mergeHarnessSettings(settings, {})} update={patch => setSettings(previous => patchHarnessSettings(previous, patch) as HarnessSettingsInput)} />;
  }
  await act(async () => root.render(<Settings />));
}
async function select(index: number, value: string) {
  const element = container.querySelectorAll('select')[index]!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, value }); element.dispatchEvent(new window.Event('change', { bubbles: true })); });
}

test('switches between ordinary and typed selection without changing the independent reader or enabling paid assistance', async () => {
  const reader = { providerId: 'saved', modelId: 'reader', agent: { modelSettings: { thinkingLevel: 'high' as const } } };
  const webSelection = { providerId: 'saved', modelId: 'chat', agent: { modelSettings: { thinkingLevel: 'low' as const } } };
  await render({ models: { reader, webSelection } });
  expect(container.querySelector('[data-model-slot="webSelection"]')).toBeTruthy();
  await select(0, JSON.stringify(['account', 'selector']));
  expect(latest.fastDecision?.purposes?.['web-selection']).toEqual({ protocol: 'typed-classifier', providerId: 'account', modelId: 'selector' });
  expect(latest.models?.reader).toEqual(reader); expect(latest.web?.readingAssistance).not.toBe(true);
  await select(0, 'chat');
  expect(latest.fastDecision?.purposes?.['web-selection']).toBe('off');
  expect(latest.models?.webSelection).toEqual({ ...webSelection, enabled: true });
  await select(0, 'default');
  expect(latest.models?.webSelection).toEqual({ ...webSelection, enabled: false });
  expect(latest.models?.reader).toEqual(reader);
});

test('reading assistance is explicitly opt-in and disabling it retains the selected model', async () => {
  await render();
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="settings.page.harness.web.assistance.readingEnabled"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await select(1, JSON.stringify(['account', 'selector']));
  await act(async () => toggle.click()); expect(latest.web?.readingAssistance).toBe(true);
  await act(async () => toggle.click()); expect(latest.web?.readingAssistance).toBe(false);
  expect(latest.fastDecision?.purposes?.['web-reading']).toEqual({ protocol: 'typed-classifier', providerId: 'account', modelId: 'selector' });
});

test('enables search selection independently while retaining anonymous defaults or configured connections', async () => {
  await render();
  const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="settings.page.harness.web.assistance.selectionEnabled"]')!;
  await act(async () => toggle().click());
  expect(latest.web?.search).toEqual({ smartSelection: true });
  expect(latest.web?.readingAssistance).not.toBe(true);
  expect(mergeHarnessSettings(latest, {}).web?.search).toMatchObject({ smartSelection: true });
  expect(mergeHarnessSettings(latest, {}).web?.search).not.toHaveProperty('connections');
  await act(async () => root.unmount()); root = createRoot(container);
  const search = { connections: [{ id: 'one', provider: 'exa' as const, name: 'Research', credentialRef: 'key-one', enabled: true }],
    defaultConnectionId: 'one', fallbackConnectionIds: ['one'] };
  await render({ web: { search } });
  await act(async () => toggle().click());
  expect(latest.web?.search).toEqual({ ...search, smartSelection: true });
  await act(async () => toggle().click());
  expect(latest.web?.search).toEqual({ ...search, smartSelection: false });
});

test('retains and displays an unavailable saved decision model without silently replacing it', async () => {
  const binding = { protocol: 'typed-classifier' as const, providerId: 'missing', modelId: 'saved-selector', endpoint: '/previous-provider-path' };
  await render({ fastDecision: { purposes: { 'web-selection': binding } } });
  expect(container.textContent).toContain('saved-selector');
  expect(container.textContent).toContain('settings.delegationModelSelection.unavailable');
  expect(latest.fastDecision?.purposes?.['web-selection']).toEqual(binding);
  await select(0, JSON.stringify(['account', 'selector']));
  expect(latest.fastDecision?.purposes?.['web-selection']).toEqual({ protocol: 'typed-classifier', providerId: 'account', modelId: 'selector' });
});
