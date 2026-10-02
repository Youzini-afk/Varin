import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiAssistantMessage, PiSessionEntry, Thread, ThreadRun } from '@varin/protocol';
import type { RuntimeAPIs } from '@varin/application-client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { PiTimelineEntryList } from './PiTimelineEntries';
import { HarnessThreadStateContext } from './HarnessThreadStateContext';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

const liveAssistant: PiAssistantMessage = {
  api: 'messages',
  content: [
    { thinking: 'Inspecting the current implementation.', type: 'thinking' },
    { text: 'This unfinished answer must not appear yet.', type: 'text' },
  ],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason: 'pending',
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
};

const runtimeAPIs = {
  editor: undefined,
  documents: { resolveWorkspace: async () => ({ workspaceId: 'workspace' }) },
} as unknown as RuntimeAPIs;

const renderTimeline = (
  assistant: PiAssistantMessage | null = liveAssistant,
  entries: PiSessionEntry[] = [],
  onOpenThread?: (entry: Extract<PiSessionEntry, { type: 'message' }>, options: { carryBlocks: boolean }) => void,
  threads: HarnessThreadSnapshot[] = [],
): string => {
  // Zustand deliberately exposes the creation snapshot during SSR. Mirror the
  // selected fields into that snapshot so this server render exercises them.
  const serverState = useUIStore.getInitialState();
  const currentState = useUIStore.getState();
  const piServerState = usePiSessionStore.getInitialState();
  const previous = {
    activityRenderMode: serverState.activityRenderMode,
    chatRenderMode: serverState.chatRenderMode,
  };
  serverState.activityRenderMode = currentState.activityRenderMode;
  serverState.chatRenderMode = currentState.chatRenderMode;
  const previousSessionId = piServerState.currentSessionId;
  piServerState.currentSessionId = 'session';
  try {
    return renderToStaticMarkup(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <I18nProvider>
          <HarnessThreadStateContext.Provider value={{
            includeArchived: false,
            merge: () => {},
            parent: { kind: 'session', id: 'session' },
            reload: async () => {},
            setIncludeArchived: () => {},
            threads,
            researchRoot: null, researchBranches: [], loadError: null,
            workspaceId: 'workspace',
          }}>
            <PiTimelineEntryList
              cwd="C:\\workspace"
              entries={entries}
              liveAssistant={assistant ?? undefined}
              onOpenThread={onOpenThread}
              sessionId="session"
              toolExecutions={{}}
            />
          </HarnessThreadStateContext.Provider>
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  } finally {
    serverState.activityRenderMode = previous.activityRenderMode;
    serverState.chatRenderMode = previous.chatRenderMode;
    piServerState.currentSessionId = previousSessionId;
  }
};

afterEach(() => {
  useUIStore.setState({ chatRenderMode: 'live' });
});

describe('Pi timeline chat render mode', () => {
  test('uses the compact explore renderer in live/sorted modes and does not label cancellation as failure', () => {
    const call = { type: 'toolCall' as const, id: 'search', name: 'explore', arguments: { question: 'Find the journal writer' } };
    const entries: PiSessionEntry[] = [{
      type: 'message', id: 'assistant', parentId: null, timestamp: 'now',
      message: { ...liveAssistant, stopReason: 'toolUse', content: [call] },
    }, {
      type: 'message', id: 'result', parentId: 'assistant', timestamp: 'now',
      message: { role: 'toolResult', toolCallId: 'search', toolName: 'explore', timestamp: 3, isError: true,
        content: [{ type: 'text', text: 'explore cancelled' }], details: {
          progress: { phase: 'cancelled', elapsedMs: 1000, receivedFiles: 0, receivedSnippets: 0, activities: [], sources: [] },
        } },
    }];
    for (const mode of ['live', 'sorted'] as const) {
      useUIStore.setState({ chatRenderMode: mode, activityRenderMode: 'summary' });
      const document = parseHTML(renderTimeline(null, entries)).document;
      const search = document.querySelector('[data-pi-explore="search"]')!;
      expect(search.textContent).toContain('Quick search');
      expect(search.textContent).toContain('Find the journal writer');
      expect(search.textContent).toContain('Search cancelled');
      expect(search.querySelector('pre')).toBeNull();
      expect(document.querySelector('[data-pi-sorted-activity] > button')?.textContent ?? '').not.toContain('Failed');
    }
  });

  test('exposes live file changes outside raw tool details in both render modes and reports a rejected mutation', () => {
    const call = { type: 'toolCall' as const, id: 'patch', name: 'apply_patch', arguments: {
      patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-old value\n+new value\n*** End Patch',
    } };
    for (const mode of ['live', 'sorted'] as const) {
      useUIStore.setState({ chatRenderMode: mode, activityRenderMode: 'summary' });
      const live = parseHTML(renderTimeline({ ...liveAssistant, content: [call] })).document;
      const preview = live.querySelector('[data-pi-file-preview="a.ts"]')!;
      expect(preview.textContent).toContain('Preparing changes');
      expect(preview.textContent).toContain('old value');
      expect(preview.textContent).toContain('new value');
      expect(preview.closest('details')).toBeNull();
      const entries: PiSessionEntry[] = [{
        type: 'message', id: 'assistant', parentId: null, timestamp: 'now',
        message: { ...liveAssistant, stopReason: 'toolUse', content: [call] },
      }, {
        type: 'message', id: 'result', parentId: 'assistant', timestamp: 'now',
        message: { role: 'toolResult', toolCallId: 'patch', toolName: 'apply_patch', timestamp: 3, isError: false,
          content: [{ type: 'text', text: 'The source changed' }], details: { applied: false } },
      }];
      const saved = parseHTML(renderTimeline(null, entries)).document;
      expect(saved.querySelector('[data-pi-file-preview]')?.textContent).toContain('Not applied');
      expect(saved.querySelector('[data-pi-tool-disclosure="tool:patch"]')?.textContent).toContain('The source changed');
      if (mode === 'sorted') expect(saved.querySelector('[data-pi-sorted-activity] > button')?.textContent).toContain('Failed');
    }
  });

  test('shows image model cost without token counts and preserves native image content', () => {
    const entries: PiSessionEntry[] = [{
      id: 'image-agent', parentId: null, timestamp: '2026-10-02T00:00:00Z', type: 'message',
      message: { ...liveAssistant, stopReason: 'stop', content: [
        { type: 'toolCall', id: 'image-call', name: 'codemode', arguments: { code: 'image(...)' } },
      ] },
    }, {
      id: 'image-result', parentId: 'image-agent', timestamp: '2026-10-02T00:00:01Z', type: 'message',
      message: { role: 'toolResult', toolCallId: 'image-call', toolName: 'codemode', isError: false, timestamp: 3,
        content: [{ type: 'image', mimeType: 'image/png', data: 'png-fixture' }],
        usage: { ...liveAssistant.usage, cost: { ...liveAssistant.usage.cost, total: 0.05 } },
        details: { calls: [{ id: 'image-call/model/1', name: 'models.generateImages', args: 'images/draw', status: 'ok', cost: 0.05 }] },
      },
    }];
    const markup = renderTimeline({ ...liveAssistant, content: [] }, entries);
    expect(markup).toContain('src="data:image/png;base64,png-fixture"');
    expect(markup).toContain('images/draw');
    expect(markup).toContain('$0.05');
    expect(markup).not.toContain('0 tokens');
    expect(markup).toContain('Calls: 1');
  });
  test('sorted mode streams activity while withholding unfinished answer text', () => {
    useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'summary' });

    const markup = renderTimeline();

    expect(markup).toContain('data-pi-sorted-activity="true"');
    expect(markup).toContain('data-pi-activity-kind="thinking"');
    expect(markup).toContain('Inspecting the current implementation.');
    expect(markup).not.toContain('This unfinished answer must not appear yet.');
  });

  test('live mode preserves the natural streaming order without an activity group', () => {
    useUIStore.setState({ chatRenderMode: 'live' });

    const markup = renderTimeline({
      ...liveAssistant,
      content: [{ thinking: 'Inspecting the current implementation.', type: 'thinking' }],
    });

    expect(markup).not.toContain('data-pi-sorted-activity="true"');
    expect(markup).toContain('group/thinking');
    expect(markup).toContain('Inspecting the current implementation.');
  });

  test('does not render an intentional abort as a red assistant error', () => {
    useUIStore.setState({ chatRenderMode: 'live' });
    const markup = renderTimeline({
      ...liveAssistant,
      errorMessage: 'This operation was aborted',
      stopReason: 'aborted',
    });

    expect(markup).not.toContain('This operation was aborted');
  });

  test('live mode folds consecutive known read-only tools but keeps writes separate', () => {
    useUIStore.setState({ chatRenderMode: 'live' });
    const assistant: PiAssistantMessage = {
      ...liveAssistant,
      content: [
        { type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'TODO', path: 'src' } },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/a.ts' } },
        { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'src/a.ts' } },
      ],
    };

    const markup = renderTimeline(assistant);
    expect(markup).toContain('Reads: 1 · Searches: 1');
    expect(markup).toContain('Edited src/a.ts');
    expect(markup).toContain('group/tools my-1');
  });

  test('renders one action row with usage below the whole turn, including a textless final reply', () => {
    const entries: PiSessionEntry[] = ['step', 'answer'].map((id, index) => ({
      type: 'message', id, parentId: index === 0 ? null : 'step', timestamp: String(index),
      message: {
        ...liveAssistant, timestamp: index, stopReason: index === 0 ? 'toolUse' : 'stop',
        content: [{ type: 'text', text: index === 0 ? 'Checking the implementation.' : 'The answer.' }],
        usage: { ...liveAssistant.usage, input: 100, output: 20, totalTokens: 120 },
      },
    }));
    for (const mode of ['live', 'sorted'] as const) {
      useUIStore.setState({ chatRenderMode: mode });
      const { document } = parseHTML(renderTimeline(null, entries));
      expect(document.querySelectorAll('[data-pi-turn-usage]').length).toBe(1);
      expect(document.querySelectorAll('[aria-label="Copy answer"]').length).toBe(1);
      const footer = document.querySelector('[data-pi-turn-footer]')!;
      expect(footer.querySelector('[aria-label="Copy answer"]')).not.toBeNull();
      expect(footer.querySelector('[title="Input: 200"]')).not.toBeNull();
      expect(footer.querySelector('[title="Output: 40"]')).not.toBeNull();
      expect(footer.parentElement?.lastElementChild).toBe(footer);
      expect(document.querySelector('article [data-pi-turn-footer]')).toBeNull();
    }

    const noText = { ...entries[1], message: { ...liveAssistant, stopReason: 'stop', content: [],
      usage: { ...liveAssistant.usage, input: 50, totalTokens: 50 } } } as PiSessionEntry;
    const emptyAnswer = parseHTML(renderTimeline(null, [entries[0]!, noText])).document;
    expect(emptyAnswer.querySelectorAll('[data-pi-turn-usage]').length).toBe(1);
    expect(emptyAnswer.querySelector('[data-pi-turn-footer] [title="Input: 150"]')).not.toBeNull();
  });

  test('copies all assistant prose once across a live handoff and forks from the final saved text reply', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const fork = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const entry: PiSessionEntry = {
      type: 'message', id: 'progress', parentId: null, timestamp: 'now',
      message: { ...liveAssistant, timestamp: 1, stopReason: 'toolUse', content: [
        { type: 'thinking', thinking: 'Hidden reasoning' },
        { type: 'text', text: 'First progress update.' },
        { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'a.ts' } },
      ] },
    };
    const finalMessage: PiAssistantMessage = { ...liveAssistant, stopReason: 'stop', content: [
      { type: 'text', text: 'The final answer.' },
    ] };
    const answer: PiSessionEntry = { ...entry, id: 'answer', parentId: 'progress', message: finalMessage };
    const render = async (entries: PiSessionEntry[], live?: PiAssistantMessage) => {
      await act(async () => root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}><I18nProvider>
          <PiTimelineEntryList cwd="/workspace" entries={entries} liveAssistant={live}
            onFork={fork} sessionId="turn-test" toolExecutions={{}} />
        </I18nProvider></RuntimeAPIContext.Provider>,
      ));
    };
    const copy = async () => {
      expect(container.querySelectorAll('[aria-label="Copy answer"]').length).toBe(1);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy answer"]')!.click());
      expect(writeText.mock.calls.at(-1)).toEqual(['First progress update.\n\nThe final answer.']);
    };
    try {
      await render([entry], { ...finalMessage, stopReason: 'pending' });
      await copy();
      // A snapshot can contain both the persisted reply and its last live overlay.
      await render([entry, answer], finalMessage);
      await copy();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Fork from this message"]')!.click());
      expect(fork.mock.calls).toEqual([[answer]]);
      await act(async () => useUIStore.setState({ chatRenderMode: 'sorted' }));
      await copy();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  test('keeps failures visible in a collapsed tool group while another call is still running in either mode', () => {
    const assistant: PiAssistantMessage = { ...liveAssistant, content: [
      { type: 'toolCall', id: 'read-failed', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'toolCall', id: 'read-running', name: 'read', arguments: { path: 'b.ts' } },
    ] };
    const entries: PiSessionEntry[] = [{
      type: 'message', id: 'result', parentId: null, timestamp: 'now', message: {
        role: 'toolResult', toolCallId: 'read-failed', toolName: 'read', timestamp: 3,
        isError: true, content: [],
      },
    }];
    for (const mode of ['live', 'sorted'] as const) {
      useUIStore.setState({ chatRenderMode: mode, activityRenderMode: 'summary' });
      const { document } = parseHTML(renderTimeline(assistant, entries));
      const group = document.querySelector('[data-pi-tool-disclosure="group:read-failed"]')!;
      expect(group.hasAttribute('open')).toBe(false);
      expect(group.querySelector('summary')?.textContent).toContain('Failed');
      expect(group.querySelector('summary')?.textContent).toContain('Running');
    }
    useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'collapsed' });
    const { document } = parseHTML(renderTimeline(assistant, entries));
    expect(document.querySelector('[data-pi-sorted-activity] > button')?.textContent).toContain('Failed');
  });

  test('keeps the user disclosure choice across streaming updates, grouping and message persistence', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const firstCall = { type: 'toolCall' as const, id: 'read-1', name: 'read', arguments: { path: 'src/a.ts' } };
    const secondCall = { ...firstCall, id: 'read-2', arguments: { path: 'src/b.ts' } };
    const render = async (assistant: PiAssistantMessage | undefined, entries: PiSessionEntry[] = []) => {
      await act(async () => root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}><I18nProvider>
          <PiTimelineEntryList cwd="/workspace" entries={entries} liveAssistant={assistant}
            sessionId="disclosure-test" toolExecutions={{}} />
        </I18nProvider></RuntimeAPIContext.Provider>,
      ));
    };
    const disclosure = (id: string) => container.querySelector<HTMLDetailsElement>(`[data-pi-tool-disclosure="${id}"]`)!;
    // linkedom does not implement native <details> activation or toggle events.
    const toggle = async (id: string, open: boolean) => {
      await act(async () => {
        const element = disclosure(id);
        element.open = open;
        element.dispatchEvent(new window.Event('toggle'));
      });
    };
    try {
      await render({ ...liveAssistant, content: [firstCall] });
      expect(disclosure('tool:read-1').hasAttribute('open')).toBe(false);
      await toggle('tool:read-1', true);
      await render({ ...liveAssistant, content: [firstCall, secondCall] });
      expect(disclosure('group:read-1').hasAttribute('open')).toBe(true);
      expect(disclosure('tool:read-1').hasAttribute('open')).toBe(true);
      const entries: PiSessionEntry[] = [{
        type: 'message', id: 'saved-tools', parentId: null, timestamp: 'now',
        message: { ...liveAssistant, stopReason: 'toolUse', content: [firstCall, secondCall] },
      }, ...[firstCall, secondCall].map((call) => ({
        type: 'message' as const, id: `result-${call.id}`, parentId: 'saved-tools', timestamp: 'now',
        message: { role: 'toolResult' as const, toolCallId: call.id, toolName: call.name,
          isError: false, timestamp: 3, content: [] },
      }))];
      await render(undefined, entries);
      expect(disclosure('group:read-1').hasAttribute('open')).toBe(true);
      expect(disclosure('tool:read-1').hasAttribute('open')).toBe(true);
      await toggle('group:read-1', false);
      await render({ ...liveAssistant, timestamp: 4, content: [] }, entries);
      expect(disclosure('group:read-1').hasAttribute('open')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  test('keeps native discussion actions and thread markers after moving memory into the selection menu', () => {
    useUIStore.setState({ chatRenderMode: 'live' });
    const entries = [{
      id: 'user-entry', parentId: null, timestamp: '2026-09-04T00:00:00.000Z', type: 'message',
      message: { role: 'user', content: 'Remember the user preference', timestamp: 1 },
    }, {
      id: 'assistant-entry', parentId: 'user-entry', timestamp: '2026-09-04T00:00:01.000Z', type: 'message',
      message: { ...liveAssistant, stopReason: 'stop', content: [{ type: 'text', text: 'Remember the answer' }] },
    }, {
      id: 'tool-entry', parentId: 'assistant-entry', timestamp: '2026-09-04T00:00:02.000Z', type: 'message',
      message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'Remember the result' }], isError: false, timestamp: 3 },
    }] as PiSessionEntry[];
    const markerThread: Thread = {
      purpose: 'task',
      id: 'thread-1', parent: { kind: 'session', id: 'session' }, workspaceId: 'workspace',
      forkPoint: { entryId: 'assistant-entry' }, brief: 'Discuss the answer', preset: null, model: null,
      manifest: { workFocus: 'code', carryBlocks: true, concurrency: 12, draftBaselineId: null, scope: [], systemPromptFragment: null, tools: ['read'], worktree: 'none' },
      createdBy: 'user', kind: 'discussion', worktree: null, lifecycle: 'active', attention: 'user',
      waitingFor: { kind: 'user', text: 'Ready' }, integration: 'none', diffStats: null, report: null,
      activeRunId: 'run-1', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z', eventSeq: 1, hidden: false,
    };
    const markerRun: ThreadRun = {
      id: 'run-1', threadId: markerThread.id, attempt: 1, runtimeId: 'pi', sessionId: 'child-1',
      sessionOwner: 'spawned-child',
      workerState: 'running', outcome: null, exitReason: null, tokens: { input: 0, output: 0, cacheRead: 0 },
      costUsd: null, steps: 0, lastToolCall: null, startedAt: markerThread.createdAt,
      lastActivityAt: markerThread.updatedAt, endedAt: null,
    };
    const markup = renderTimeline(
      liveAssistant,
      entries,
      () => undefined,
      [{ thread: markerThread, activeRun: markerRun }],
    );
    expect(markup).not.toContain('aria-label="Add to knowledge review"');
    expect(markup.match(/aria-label="Open a discussion thread from this message"/g)?.length).toBe(2);
    expect(markup).toContain('data-harness-thread-markers="assistant-entry"');
    expect(markup).toContain('aria-label="Open thread: Discussion thread"');
  });
});
