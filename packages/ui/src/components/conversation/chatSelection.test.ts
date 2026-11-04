import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { captureChatSelection, chatTextSourceOffset, type ChatTextSource } from './chatSelection';

// Linkedom supplies the actual rendered tree/walker; its missing Range intersection
// methods are supplied from explicit text-node boundaries, not source-text matching.
function selection(html: string, source: ChatTextSource, selectors: string[], visible?: string) {
  const { document, window } = parseHTML(`<html><body><main>${html}</main></body></html>`);
  vi.stubGlobal('document', document); vi.stubGlobal('Node', window.Node); vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
  const root = document.querySelector('main')!;
  const nodes = selectors.map(selector => document.querySelector(selector)!.firstChild!);
  const range = { startContainer: nodes[0], startOffset: 0, endContainer: nodes.at(-1), endOffset: nodes.at(-1)!.textContent!.length,
    intersectsNode: (node: Node) => nodes.some(selected => node === selected || node.contains(selected)),
    toString: () => visible ?? nodes.map(node => node.textContent).join('') } as unknown as Range;
  return captureChatSelection(range, new Map([[root, source]]));
}
afterEach(() => vi.unstubAllGlobals());
const fence = '```varin-ui\n{"type":"choice","label":"Repeat","options":["Repeat"],"action":"Repeat"}\n```\n';
it('maps prose after a control to its real source occurrence rather than matching hidden JSON or control labels', () => {
  const text = 'Before\n\n' + fence + '\nRepeat';
  const result = selection('<p id="before">Before</p><form data-conversation-ui-fragment="x"><label>Repeat</label><button>Repeat</button></form><p id="after">Repeat</p>',
    { role: 'assistant', entryId: 'native', text, offset: 17 }, ['#after']);
  expect(result).toEqual({ text: 'Repeat', complete: true, passages: [{ entryId: 'native', start: 17 + text.lastIndexOf('Repeat'), text: 'Repeat' }] });
});
it('splits prose spanning an interactive fragment into exact original passages without including its JSON', () => {
  const text = 'Before\n\n' + fence + '\nAfter';
  const result = selection('<p id="before">Before</p><form data-conversation-ui-fragment="x"><label>Repeat</label></form><p id="after">After</p>',
    { role: 'assistant', entryId: 'native', text, offset: 0 }, ['#before', '#after']);
  expect(result.complete).toBe(true);
  expect(result.passages).toEqual([{ entryId: 'native', start: 0, text: 'Before' }, { entryId: 'native', start: text.lastIndexOf('After'), text: 'After' }]);
});
it('does not label selected controls as quoted assistant prose, but keeps user fenced examples and invalid fallback readable', () => {
  const control = selection('<form data-conversation-ui-fragment="x"><label id="control">Repeat</label></form>', { role: 'assistant', entryId: 'native', text: fence, offset: 0 }, ['#control']);
  expect(control.complete).toBe(false); expect(control.passages).toEqual([]);
  const body = '{"type":"choice"}';
  const user = selection(`<pre><code id="code">${body}</code></pre>`, { role: 'user', entryId: 'user', text: '```varin-ui\n' + body + '\n```', offset: 0 }, ['#code']);
  expect(user.complete).toBe(true); expect(user.passages[0]).toMatchObject({ start: 12, text: body });
  const raw = '```varin-ui\n{"type":"unknown"}\n```';
  const invalid = selection(`<pre id="invalid">${raw}</pre>`, { role: 'assistant', entryId: 'native', text: raw, offset: 0 }, ['#invalid']);
  expect(invalid.complete).toBe(true); expect(invalid.passages[0]?.text).toBe(raw);
});
it('resolves native part indices and identities independently of visible-array position', () => {
  const content = [{ type: 'thinking', id: 'reasoning' }, { type: 'text', id: 'one', contentIndex: 0, text: 'First' }, { type: 'text', id: 'three', contentIndex: 3, text: 'Second' }];
  expect(chatTextSourceOffset({ text: 'Second', offset: 0, contentIndex: 3 }, content)).toBe(6);
  expect(chatTextSourceOffset({ text: 'Second', offset: 0, contentIndex: 1, contentIdentity: 'three' }, content)).toBe(6);
  expect(chatTextSourceOffset({ text: 'First', offset: 0, contentIndex: 0, contentIdentity: 'one' }, content)).toBe(0);
  expect(chatTextSourceOffset({ text: 'Detached', offset: 42, contentIndex: 99 }, content)).toBe(42);
});
