import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceModelField } from './InferenceModelField';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange(value: string): void }) =>
    <div><button onClick={() => onValueChange('model:known-model')}>choose model</button>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock('./AutoSaveInput', () => ({
  // Exercise the real input contract: a pending typed value commits on unmount.
  AutoSaveInput: ({ onCommit }: { onCommit(value: string): void }) => {
    const [pendingCommit] = React.useState(() => onCommit);
    React.useEffect(() => () => pendingCommit('older-manual-model'), [pendingCommit]);
    return <input aria-label="pending manual model" />;
  },
}));

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('inference model choice', () => {
  it('does not overwrite a selected declared model with an older manual input during unmount', async () => {
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const commits: string[] = [];
    function Field() {
      const [value, setValue] = React.useState('manual-model');
      return <InferenceModelField models={[{ id: 'known-model' }]} value={value} label="model" placeholder="ID"
        onCommit={id => { commits.push(id); setValue(id); }} />;
    }
    root = createRoot(window.document.getElementById('app')!);
    await act(async () => root!.render(<Field />));
    await act(async () => window.document.querySelector<HTMLButtonElement>('button')!.click());
    expect(commits).toEqual(['known-model']);
    expect(window.document.querySelector('input')).toBeNull();
  });
});
