import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { usePacedText } from './usePacedText';
import { projectChatSortedTurn, CHAT_SORTED_LIVE_ASSISTANT_ID } from '../conversation/chatSortedTurnProjection';
import { assistant } from '../conversation/historyPresentation';

it('reveals continuously arriving text before generation completes, including in grouped mode', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const container = document.createElement('div'); const root = createRoot(container);
  function View({ text, streaming = true }: { text: string; streaming?: boolean }) {
    return <p>{usePacedText(text, streaming)}</p>;
  }
  try {
    let text = '';
    for (let index = 0; index < 20; index += 1) {
      text += '字';
      const grouped = projectChatSortedTurn([], assistant('live', [{ type: 'text', text }], {}, true));
      const answer = grouped.answersBySourceId.get(CHAT_SORTED_LIVE_ASSISTANT_ID)!;
      expect(answer.stopReason).toBe('pending');
      await act(async () => root.render(<View text={text} />));
      await act(async () => vi.advanceTimersByTime(10));
      if (index === 7) expect(container.textContent!.length).toBeGreaterThan(0);
    }
    expect(container.textContent!.length).toBeGreaterThan(5);
    await act(async () => root.render(<View text={text} streaming={false} />));
    expect(container.textContent).toBe(text);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
