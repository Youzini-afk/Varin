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

  test('puts the turn totals beside the terminal message actions without changing earlier message ownership', () => {
    const entries: PiSessionEntry[] = ['step', 'answer'].map((id, index) => ({
      type: 'message', id, parentId: index === 0 ? null : 'step', timestamp: String(index),
      message: {
        ...liveAssistant, timestamp: index, stopReason: index === 0 ? 'toolUse' : 'stop',
        content: [{ type: 'text', text: index === 0 ? 'Checking the implementation.' : 'The answer.' }],
        usage: { ...liveAssistant.usage, input: 100, output: 20, totalTokens: 120 },
      },
    }));
    const { document } = parseHTML(renderTimeline(null, entries));
    expect(document.querySelectorAll('[data-pi-turn-usage]').length).toBe(1);
    const answerFooter = document.querySelector('#pi-entry-answer [data-pi-message-footer]')!;
    expect(answerFooter.querySelector('[aria-label="Copy answer"]')).not.toBeNull();
    expect(answerFooter.querySelector('[title="Input: 200"]')).not.toBeNull();
    expect(answerFooter.querySelector('[title="Output: 40"]')).not.toBeNull();
    const step = document.querySelector('#pi-entry-step')!;
    expect(step.querySelector('[aria-label="Copy answer"]')).not.toBeNull();
    expect(step.querySelector('[data-pi-turn-usage]')).toBeNull();

    const noText = { ...entries[1], message: { ...liveAssistant, stopReason: 'stop', content: [],
      usage: { ...liveAssistant.usage, input: 50, totalTokens: 50 } } } as PiSessionEntry;
    const emptyAnswer = parseHTML(renderTimeline(null, [entries[0]!, noText])).document;
    expect(emptyAnswer.querySelectorAll('[data-pi-turn-usage]').length).toBe(1);
    expect(emptyAnswer.querySelector('#pi-entry-answer [title="Input: 150"]')).not.toBeNull();
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

  test('persisted messages and tool results expose the scoped knowledge review action', () => {
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
    expect(markup.match(/aria-label="Add to knowledge review"/g)?.length).toBe(3);
    expect(markup.match(/aria-label="Open a discussion thread from this message"/g)?.length).toBe(2);
    expect(markup).toContain('data-harness-thread-markers="assistant-entry"');
    expect(markup).toContain('aria-label="Open thread: Discussion thread"');
  });
});
