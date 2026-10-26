import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ThreadComposer } from './ThreadComposer';

const editor = vi.hoisted(() => ({ props: undefined as React.ComponentProps<typeof import('@/components/chat/composer/editor/ComposerEditor').ComposerEditor> | undefined,
  selection: { start: 0, end: 0 }, menuKey: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useComposerHeightGlide', () => ({ useComposerHeightGlide: () => {} }));
vi.mock('../conversation/useFileDropField', () => ({ useFileDropField: () => {} }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/sections/agents/ModelSelector', () => ({ ModelSelector: () => null }));
vi.mock('@/components/dictation/ComposerDictation', () => ({ ComposerDictation: () => null }));
vi.mock('./ThreadPermissionControl', () => ({ ThreadPermissionControl: () => null }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ WorkbenchContributionSlot: () => null }));
vi.mock('@/components/motion/SwapIcon', () => ({ SwapIcon: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/motion/SwapText', () => ({ SwapText: () => null }));
vi.mock('motion/react', () => ({ motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>) } }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => children, TooltipTrigger: ({ children }: React.PropsWithChildren) => children, TooltipContent: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: ({ children }: React.PropsWithChildren) => children, DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => children, DropdownMenuContent: () => null, DropdownMenuItem: () => null }));
vi.mock('@/components/chat/CommandAutocomplete', () => ({ CommandAutocomplete: React.forwardRef((_props, ref) => { React.useImperativeHandle(ref, () => ({ handleKeyDown: editor.menuKey })); return null; }) }));
vi.mock('@/components/chat/SkillAutocomplete', () => ({ SkillAutocomplete: () => null }));
vi.mock('@/components/chat/FileMentionAutocomplete', () => ({ FileMentionAutocomplete: React.forwardRef((_props, ref) => { React.useImperativeHandle(ref, () => ({ handleKeyDown: editor.menuKey })); return null; }) }));
// Exercise the real composer keyboard/form routing through the existing editor port.
vi.mock('@/components/chat/composer/editor/ComposerEditor', () => ({ ComposerEditor: React.forwardRef<ComposerEditorHandle, NonNullable<typeof editor.props>>((props, ref) => {
  editor.props = props;
  React.useImperativeHandle(ref, () => ({
    getValue: () => props.value, getSelection: () => editor.selection,
    insertText: text => {
      const next = props.value.slice(0, editor.selection.start) + text + props.value.slice(editor.selection.end);
      const position = editor.selection.start + text.length; editor.selection = { start: position, end: position };
      props.onChange({ value: next, selection: editor.selection, fromPaste: false, insertedText: text });
    }, focus: () => {}, blur: () => {}, isFocused: () => true, caretCoords: () => null, replaceRange: () => {}, selectAll: () => {},
    setSelection: (start, end = start) => { editor.selection = { start, end }; },
  }));
  return <textarea aria-label="editor" value={props.value} placeholder={props.suggestion ?? props.placeholder}
    onInput={event => props.onChange({ value: event.currentTarget.value, selection: editor.selection, fromPaste: false, insertedText: '' })} />;
}) }));

let root: Root; let container: HTMLDivElement;
let sent: string[];
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  editor.selection = { start: 0, end: 0 }; sent = []; editor.menuKey.mockReset();
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  const [suggestion, setSuggestion] = React.useState<string | undefined>('好，继续完善吧');
  return <form ref={form => { if (form) form.requestSubmit = () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }; }}
    onSubmit={event => { event.preventDefault(); sent.push(value); }}>
    <ThreadComposer editorRef={null} value={value} onChange={setValue} suggestion={suggestion} onSuggestionDismiss={() => setSuggestion(undefined)}
      models={[]} providerId="provider" modelId="model" thinkingLevel="off" onModelChange={() => {}}
      modelDisabled={false} attachmentDisabled={false} imageDisabled={false} sendDisabled={false} pending={false} active={false} retrying={false}
      delivery="boundary" onDeliveryChange={() => {}} allowNextRun onFiles={() => {}} onAttachImages={() => {}} onAttachPdfs={() => {}}
      onGoal={() => {}} hasInput={Boolean(value.trim())} onWorkspace={() => {}} workspaceLabel="Project" attachmentNames={[]} skills={[]} />
  </form>;
}
async function key(key: string, extra: Partial<KeyboardEvent> = {}) {
  let handled = false;
  await act(async () => { handled = editor.props!.onKeyDown!({ key, preventDefault() {}, stopPropagation() {}, ...extra } as KeyboardEvent); });
  return handled;
}

it('keeps the suggestion out of the draft until Tab accepts it', async () => {
  await act(async () => root.render(<Harness />));
  expect(editor.props!.value).toBe(''); expect(editor.props!.suggestion).toBe('好，继续完善吧');
  expect(await key('Tab')).toBe(true);
  expect(editor.props!.value).toBe('好，继续完善吧'); expect(editor.props!.suggestion).toBeUndefined(); expect(sent).toEqual([]);
  expect(await key('Tab')).toBe(false);
  await act(async () => {
    editor.selection = { start: 0, end: 0 };
    editor.props!.onChange({ value: '', selection: editor.selection, fromPaste: false, insertedText: '' });
  });
  expect(editor.props!.suggestion).toBe('好，继续完善吧');
  expect(await key('Tab')).toBe(true);
  expect(editor.props!.value).toBe('好，继续完善吧');
});

it('hides ghost text while typing and inserts the retained suggestion at the cursor', async () => {
  await act(async () => root.render(<Harness initial="前文，后文" />));
  expect(editor.props!.suggestion).toBeUndefined(); editor.selection = { start: 3, end: 3 };
  await key('Tab'); expect(editor.props!.value).toBe('前文，好，继续完善吧后文');
  expect(editor.selection.start).toBe('前文，好，继续完善吧'.length);
});

it('Enter and the send button submit the exact displayed suggestion as an ordinary editable draft', async () => {
  await act(async () => root.render(<Harness />)); await key('Enter');
  expect(sent).toEqual(['好，继续完善吧']); expect(editor.props!.value).toBe('好，继续完善吧');
  await act(async () => root.render(<Harness key="new" />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-conversation-composer-primary-action="send"]')!.click());
  expect(sent).toEqual(['好，继续完善吧', '好，继续完善吧']);
});

it('preserves IME confirmation, Shift+Tab focus navigation, and normal draft submission', async () => {
  await act(async () => root.render(<Harness />));
  expect(await key('Enter', { isComposing: true })).toBe(false);
  expect(await key('Tab', { shiftKey: true })).toBe(false); expect(sent).toEqual([]); expect(editor.props!.value).toBe('');
  await act(async () => root.render(<Harness key="typed" initial="我自己写的" />)); await key('Enter');
  expect(sent).toEqual(['我自己写的']);
});

it.each(['/tre', '@file'])('preserves both hints and gives the %s menu Tab priority', async value => {
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('chat.composer.hint');
  expect(container.textContent).toContain('chat.suggestion.acceptAndSendHint');
  await act(async () => editor.props!.onChange({ value, selection: { start: value.length, end: value.length }, fromPaste: false, insertedText: value }));
  expect(container.textContent).not.toContain('chat.suggestion.insertHint');
  await key('Tab'); expect(editor.menuKey).toHaveBeenCalledWith('Tab'); expect(editor.props!.value).toBe(value);
});

it('keeps an explicitly dismissed suggestion closed', async () => {
  await act(async () => root.render(<Harness />));
  expect(await key('Escape')).toBe(true);
  expect(editor.props!.suggestion).toBeUndefined();
  expect(await key('Tab')).toBe(false);
});
