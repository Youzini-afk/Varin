import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePacedText, type PacedText } from './usePacedText';
import { projectChatSortedTurn, CHAT_SORTED_LIVE_ASSISTANT_ID } from '../conversation/chatSortedTurnProjection';
import { assistant } from '../conversation/historyPresentation';

let container: HTMLElement;
let root: Root;
let latest: PacedText;

function View({ text, streaming = true, id }: { text: string; streaming?: boolean; id?: string }) {
  latest = usePacedText(text, streaming, id);
  return <p>{latest.text}</p>;
}

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

it('reveals continuously arriving text before generation completes, including in grouped mode', async () => {
  let text = '';
  for (let index = 0; index < 20; index += 1) {
    text += '字';
    const grouped = projectChatSortedTurn([], assistant('live', [{ type: 'text', text }], {}, true));
    const answer = grouped.answersBySourceId.get(CHAT_SORTED_LIVE_ASSISTANT_ID)!;
    expect(answer.stopReason).toBe('pending');
    await act(async () => root.render(<View text={text} />));
    await advance(10);
    if (index === 7) expect(container.textContent!.length).toBeGreaterThan(0);
  }
  expect(container.textContent!.length).toBeGreaterThan(5);
  await act(async () => root.render(<View text={text} streaming={false} />));
  await advance(240);
  expect(container.textContent).toBe(text);
  expect(latest.revealing).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('shows text that was never streamed at once', async () => {
  await act(async () => root.render(<View text="Persisted answer" streaming={false} />));
  expect(container.textContent).toBe('Persisted answer');
  expect(latest.revealing).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('catches up with a burst smoothly instead of all at once', async () => {
  await act(async () => root.render(<View text="" />));
  const burst = 'x'.repeat(400);
  await act(async () => root.render(<View text={burst} />));
  await advance(48);
  const early = container.textContent!.length;
  expect(early).toBeGreaterThan(0);
  expect(early).toBeLessThan(200);
  await advance(240);
  expect(container.textContent!.length).toBeGreaterThan(200);
  await advance(1600);
  expect(container.textContent!.length).toBe(400);
});

it('drains the backlog evenly after the stream ends and stays revealing until it has', async () => {
  await act(async () => root.render(<View text="" />));
  const text = 'y'.repeat(600);
  await act(async () => root.render(<View text={text} />));
  await advance(32);
  await act(async () => root.render(<View text={text} streaming={false} />));
  expect(latest.revealing).toBe(true);
  const start = container.textContent!.length;
  await advance(80);
  const middle = container.textContent!.length;
  expect(middle).toBeGreaterThan(start);
  expect(middle).toBeLessThan(600);
  await advance(160);
  expect(container.textContent!.length).toBe(600);
  expect(latest.revealing).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('continues a reveal across a remount of the same reply', async () => {
  await act(async () => root.render(<View text="" id="reply" />));
  const text = 'z'.repeat(500);
  await act(async () => root.render(<View text={text} id="reply" />));
  await advance(64);
  const before = container.textContent!.length;
  expect(before).toBeLessThan(500);
  // A layout that swaps the live reply for its persisted entry remounts it.
  await act(async () => root.render(<></>));
  await act(async () => root.render(<View text={text} streaming={false} id="reply" />));
  expect(container.textContent!.length).toBe(before);
  await advance(240);
  expect(container.textContent!.length).toBe(500);
});

it('joins a stream in progress near its end', async () => {
  const text = 'w'.repeat(2000);
  await act(async () => root.render(<View text={text} />));
  expect(container.textContent!.length).toBeGreaterThan(1800);
  await advance(1200);
  expect(container.textContent!.length).toBe(2000);
});
