import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import type { FollowUpDefinitionView } from '@varin/protocol';
import { FollowUpEditorDialog } from './FollowUpEditorDialog';
import { useBotSessionIndex } from '@/stores/useBotSessionIndex';

const mocks = vi.hoisted(() => ({
  saved: vi.fn(), close: vi.fn(),
  state: { catalogLoaded: true, currentSessionId: 's-1', runtimeKey: 'test', summaries: [{ id: 's-1', name: 'Experiment', firstMessage: '', cwd: '/repo', workspace: { kind: 'workspace', id: 'project' } }] },
}));
vi.mock('@varin/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: Object.assign((select: (state: typeof mocks.state) => unknown) => select(mocks.state), { getState: () => mocks.state }),
  selectActivePiSessions: (state: typeof mocks.state) => state.summaries,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
vi.mock('@/components/ui/select', () => {
  const Children = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Select: Children, SelectTrigger: Children, SelectValue: Children, SelectContent: Children, SelectItem: Children };
});
vi.mock('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={props.onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={props.onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));

const existing = (source: FollowUpDefinitionView['source']): FollowUpDefinitionView => ({
  id: 'wait-1', workspaceId: 'ws', sessionId: 's-1', source, status: 'waiting', revision: '3',
  instruction: 'Inspect the result', waitingSummary: 'Wait for the experiment', createdAt: 1, updatedAt: 1, pausedGoal: false,
});

describe('manual follow-up editor', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (entry?: FollowUpDefinitionView) => { await act(async () => { root.render(<FollowUpEditorDialog open entry={entry} onOpenChange={mocks.close} onSaved={mocks.saved} />); }); };
  const edit = async (selector: string, value: string) => {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await act(async () => { field.value = value; field.dispatchEvent(new window.Event('input', { bubbles: true })); });
  };
  const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
  beforeEach(() => {
    useBotSessionIndex.setState({ runtimeKey: 'test', ids: new Set(), loading: false, error: null });
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(runtimeFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({ followUp: { id: 'new-wait' } }), { status: 201 }));
    mocks.saved.mockReset();
    mocks.close.mockReset();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); useBotSessionIndex.setState({ runtimeKey: null, ids: null, loading: false, error: null }); vi.unstubAllGlobals(); });

  it('creates a timed continuation in the selected conversation without pausing it', async () => {
    await render();
    await edit('textarea', '  Check the experiment results  ');
    await submit();
    const [url, init] = vi.mocked(runtimeFetch).mock.calls[0]!;
    expect(url).toBe('/api/harness/sessions/s-1/follow-ups');
    const body = JSON.parse(String(init!.body));
    expect(body.instruction).toBe('Check the experiment results');
    expect(body.pause).toBe(false);
    expect(body.source.kind).toBe('time');
    expect(body.source.at).toBeGreaterThan(Date.now());
    expect(mocks.saved).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledWith(false);
  });

  it('keeps an advanced Agent source intact when only its instruction changes', async () => {
    await render(existing({ kind: 'all', sources: [{ kind: 'file', path: 'data.json', condition: 'exists' }, { kind: 'manual' }] }));
    await edit('textarea', 'Analyse the completed data');
    await submit();
    const [url, init] = vi.mocked(runtimeFetch).mock.calls[0]!;
    expect(url).toBe('/api/harness/sessions/s-1/follow-ups/wait-1/update');
    expect(JSON.parse(String(init!.body))).toEqual({ instruction: 'Analyse the completed data', expectedRevision: '3' });
  });

  it('retains the deadline when editing a file path', async () => {
    await render(existing({ kind: 'file', path: 'old.json', condition: 'exists', fallbackAt: 2_000_000_000_000 }));
    await edit('input:not([placeholder])', 'new.json');
    await submit();
    const body = JSON.parse(String(vi.mocked(runtimeFetch).mock.calls[0]![1]!.body));
    expect(body.source).toEqual({ kind: 'file', path: 'new.json', condition: 'exists', fallbackAt: 2_000_000_000_000 });
  });

  it('retains the input and reports a failed save', async () => {
    vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'revision conflict' }), { status: 409 }));
    await render(existing({ kind: 'manual' }));
    await edit('textarea', 'Keep this instruction');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('revision conflict');
    expect(container.querySelector('textarea')?.value).toBe('Keep this instruction');
    expect(mocks.saved).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
