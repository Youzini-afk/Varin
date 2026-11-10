import { beforeEach, expect, it, vi } from 'vitest';
import { useThreadDraftStore } from './useThreadDraftStore';

beforeEach(() => useThreadDraftStore.setState({ drafts: {} }));

it('materializes an empty draft, then retains its identity on semantic no-ops', () => {
  const store = useThreadDraftStore.getState();
  store.patch('global', { workspacePath: undefined });
  expect(useThreadDraftStore.getState().drafts.global).toMatchObject({ text: '', images: [], preparedSource: null });
  const model = { providerId: 'channel', modelId: 'model', thinkingLevel: 'off' as const, temperature: 0 };
  store.patch('global', { model });
  const draft = useThreadDraftStore.getState().drafts.global;
  const notification = vi.fn();
  const unsubscribe = useThreadDraftStore.subscribe(notification);
  try {
    store.patch('global', {});
    store.patch('global', current => ({ text: current.text, images: current.images, model: { ...model } }));
    expect(notification).not.toHaveBeenCalled();
    expect(useThreadDraftStore.getState().drafts.global).toBe(draft);
    store.patch('global', { model: { ...model, temperature: undefined } });
    expect(notification).toHaveBeenCalledOnce();
    expect(useThreadDraftStore.getState().drafts.global?.model?.temperature).toBeUndefined();
  } finally { unsubscribe(); }
});
