import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dropFieldGlow, useFileDropField } from './useFileDropField';

let root: Root;
let doc: Document;
let win: Window;

function Harness({ disabled = false, onFiles }: { disabled?: boolean; onFiles: (files: File[]) => void }) {
  const frame = React.useRef<HTMLDivElement>(null);
  useFileDropField(frame, { disabled, onFiles });
  return <section className="regular-chat-view">
    <p data-outside>conversation</p>
    <div ref={frame} data-frame><span data-inside>composer</span></div>
  </section>;
}

beforeEach(() => {
  const parsed = parseHTML('<html><body><div id="app"></div></body></html>');
  doc = parsed.document;
  win = parsed.window as unknown as Window;
  vi.stubGlobal('window', parsed.window); vi.stubGlobal('document', parsed.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Node', parsed.window.Node);
  root = createRoot(doc.getElementById('app')!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const file = { name: 'a.png', type: 'image/png' } as File;
const drag = (type: string, target: Element, types: string[] = ['Files']): Event => {
  const event = new (win as unknown as { Event: typeof Event }).Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: 10 }, clientY: { value: 10 }, relatedTarget: { value: null },
    dataTransfer: { value: { types, files: [file], items: [], dropEffect: 'none' } },
  });
  target.dispatchEvent(event);
  return event;
};

it('glows smoothly from the pointer out to its radius', () => {
  expect(dropFieldGlow(0, 100)).toBe(1);
  expect(dropFieldGlow(100, 100)).toBe(0);
  expect(dropFieldGlow(50, 100)).toBeCloseTo(0.5);
  expect(dropFieldGlow(10, 0)).toBe(0);
});

it('takes system files dropped anywhere in the conversation, but leaves the composer its own drops', async () => {
  const onFiles = vi.fn();
  await act(async () => root.render(<Harness onFiles={onFiles} />));
  const outside = doc.querySelector('[data-outside]')!;
  drag('dragenter', outside);
  expect(drag('dragover', outside).defaultPrevented).toBe(true);
  const dropped = drag('drop', outside);
  expect(dropped.defaultPrevented).toBe(true);
  expect(onFiles).toHaveBeenCalledWith([file]);

  onFiles.mockClear();
  const inside = doc.querySelector('[data-inside]')!;
  drag('dragenter', inside);
  drag('drop', inside);
  expect(onFiles).not.toHaveBeenCalled();
});

it('ignores internal drags and a composer that cannot take attachments', async () => {
  const onFiles = vi.fn();
  await act(async () => root.render(<Harness onFiles={onFiles} />));
  const outside = doc.querySelector('[data-outside]')!;
  drag('dragenter', outside, ['application/x-varin-file-path']);
  expect(drag('dragover', outside, ['application/x-varin-file-path']).defaultPrevented).toBe(false);
  drag('drop', outside, ['application/x-varin-file-path']);
  expect(onFiles).not.toHaveBeenCalled();

  await act(async () => root.render(<Harness onFiles={onFiles} disabled />));
  drag('dragenter', outside);
  expect(drag('dragover', outside).defaultPrevented).toBe(false);
  drag('drop', outside);
  expect(onFiles).not.toHaveBeenCalled();
});
