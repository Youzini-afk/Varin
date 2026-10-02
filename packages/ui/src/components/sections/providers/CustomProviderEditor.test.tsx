import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_INFERENCE_CAPABILITIES } from '@varin/protocol';
import { CustomProviderEditor } from './CustomProviderEditor';
import { createEmptyCustomProviderState } from './customProviderForm';

const mocks = vi.hoisted(() => ({ discover: vi.fn(), save: vi.fn(), load: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/pi-runtime/providers', () => ({ discoverPiProviderModels: mocks.discover, upsertPiProviderConfig: mocks.save }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error, success: vi.fn() } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: '/workspace' }) }));
vi.mock('@/stores/usePiProviderStore', () => ({ usePiProviderStore: Object.assign(
  (select: (state: { allProviders: [] }) => unknown) => select({ allProviders: [] }),
  { getState: () => ({ load: mocks.load }) },
) }));
vi.mock('./ProviderAuthPanel', () => ({ ProviderAuthPromptView: () => null,
  usePiProviderAuth: () => ({ busy: false, start: async () => ({ status: 'authenticated' }) }),
}));
vi.mock('./CustomProviderReasoningLevels', () => ({ CustomProviderReasoningLevels: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
vi.mock('@/components/ui/input', () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => <input ref={ref} {...props} />),
}));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onChange, ariaLabel }: { checked: boolean; onChange(value: boolean): void; ariaLabel?: string }) =>
    <button role="checkbox" aria-label={ariaLabel} aria-checked={checked} onClick={() => onChange(!checked)} />,
}));
vi.mock('@/components/ui/switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/select', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Select: Container, SelectContent: Container, SelectItem: Container, SelectTrigger: Container, SelectValue: Container };
});
vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Container, DialogDescription: Container, DialogFooter: Container, DialogHeader: Container, DialogTitle: Container,
  };
});

const initialForm = () => {
  const state = createEmptyCustomProviderState();
  state.id = 'draft-provider';
  state.apiKey = 'draft-key';
  state.api = 'anthropic-messages';
  state.baseURL = 'https://provider.example/v1';
  state.chatEnabled = false;
  state.models[0]!.id = 'existing-chat';
  for (const kind of PROVIDER_INFERENCE_CAPABILITIES) {
    state.inference[kind].enabled = true;
    state.inference[kind].baseURL = `https://${kind}.example/v1`;
    state.inference[kind].models = [{ ...state.models[0]!, id: `existing-${kind}` }];
  }
  state.inference.rerank.credentialRef = 'rerank-owner';
  return state;
};

describe('custom provider model import', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.save.mockResolvedValue({});
    mocks.load.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  const click = async (label: string, scope: ParentNode = container) => {
    const button = [...scope.querySelectorAll('button')].find(node => node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const fetchModels = async (kind: string) => {
    const section = [...container.querySelectorAll('section')].find(node => node.textContent.includes(`capability.${kind}`));
    expect(section).toBeDefined();
    await click('settings.providers.page.actions.fetchModels', section!);
  };

  it.each(PROVIDER_INFERENCE_CAPABILITIES)('fetches and saves selected %s models only in that capability', async kind => {
    mocks.discover.mockResolvedValue({ models: [
      { id: 'chosen', ...(kind === 'decision' ? { api: 'typesafe-system-one', type: 'classifier' } : {}) },
      { id: 'unselected' },
    ] });
    await act(async () => root.render(<CustomProviderEditor mode="create" initialState={initialForm()} />));
    await fetchModels(kind);
    const options = mocks.discover.mock.calls[0]![2];
    expect(options.capability).toBe(kind);
    expect(options.apiKey).toBe(kind === 'rerank' ? undefined : 'draft-key');
    expect(options.config.capabilities[kind].baseUrl).toBe(`https://${kind}.example/v1`);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect([...dialog.querySelectorAll('[role="checkbox"]')].every(node => node.getAttribute('aria-checked') === 'false')).toBe(true);
    const chosen = dialog.querySelector<HTMLButtonElement>('[aria-label="chosen"]')!;
    await act(async () => chosen.click());
    await click('settings.providers.page.modelImport.actions.apply', dialog);
    await click('settings.providers.page.actions.saveProvider');
    expect(mocks.save).toHaveBeenCalledOnce();
    const config = mocks.save.mock.calls[0]![2];
    expect(config.models.map((model: { id: string }) => model.id)).toEqual(['existing-chat']);
    for (const capability of PROVIDER_INFERENCE_CAPABILITIES) {
      expect(config.capabilities[capability].models.map((model: { id: string }) => model.id)).toEqual(
        capability === kind ? [`existing-${kind}`, 'chosen'] : [`existing-${capability}`],
      );
    }
    if (kind === 'decision') expect(config.capabilities.decision.models[1].api).toBe('typesafe-system-one');
  });

  it('cancels and ignores a late response after the editor changes provider', async () => {
    let finish!: (result: unknown) => void;
    mocks.discover.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<CustomProviderEditor mode="create" initialState={initialForm()} />));
    await fetchModels('embedding');
    const signal = mocks.discover.mock.calls[0]![2].signal as AbortSignal;
    await act(async () => root.render(<CustomProviderEditor mode="create" initialState={{ ...initialForm(), id: 'other-provider' }} />));
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ models: [{ id: 'stale-model' }] }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
