import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerReference } from '@/components/chat/composer/editor/references';
import type { WorkbenchCommandRegistration, ComposerCommandAction } from '@/lib/commands/surface-command-types';
import type { CommandInfo } from '@/components/chat/CommandAutocomplete';
import { ThreadComposer } from './ThreadComposer';

const editor = vi.hoisted(() => ({ props: undefined as React.ComponentProps<typeof import('@/components/chat/composer/editor/ComposerEditor').ComposerEditor> | undefined,
  selection: { start: 0, end: 0 }, menuKey: vi.fn(), registrations: [] as WorkbenchCommandRegistration[], commandProps: undefined as { onCommandSelect(command: CommandInfo, mode: 'confirm' | 'complete'): void; onClose(): void; additionalCommands: CommandInfo[]; children?: React.ReactNode } | undefined }));
vi.mock('@/lib/commands/surface-command-registry', () => ({ useWorkbenchCommandRegistrations: () => editor.registrations }));
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
vi.mock('motion/react', () => ({ useIsPresent: () => true, AnimatePresence: ({ children }: React.PropsWithChildren) => children, motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>) } }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => children, TooltipTrigger: ({ children }: React.PropsWithChildren) => children, TooltipContent: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: ({ children }: React.PropsWithChildren) => children, DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => children, DropdownMenuContent: () => null, DropdownMenuItem: () => null }));
vi.mock('@/components/chat/CommandAutocomplete', () => ({ CommandAutocomplete: React.forwardRef((props: NonNullable<typeof editor.commandProps>, ref) => { editor.commandProps = props; React.useEffect(() => () => { editor.commandProps = undefined; }, []); React.useImperativeHandle(ref, () => ({ handleKeyDown: editor.menuKey })); return props.children; }) }));
vi.mock('@/components/chat/FileMentionAutocomplete', () => ({ FileMentionAutocomplete: React.forwardRef((_props, ref) => { React.useImperativeHandle(ref, () => ({ handleKeyDown: editor.menuKey })); return null; }) }));
// Exercise the real composer keyboard/form routing through the existing editor port.
vi.mock('@/components/chat/composer/editor/ComposerEditor', () => ({ ComposerEditor: React.forwardRef<ComposerEditorHandle, NonNullable<typeof editor.props>>((props, ref) => {
  editor.props = props;
  React.useImperativeHandle(ref, () => ({
    getEditorState: () => undefined,
    captureMarkerInsertion: () => ({ insertMarker: async () => {}, dispose: () => {} }),
    insertMarker: async () => {}, removeMarkerObject: () => {}, replaceMarkerObjects: () => {},
    composeInteraction: async () => ({ updated: false }),
    captureInsertion: () => ({ insertText: () => {}, dispose: () => {} }),
    insertReference: (from, to, text, reference) => {
      const insert = `${text} `;
      editor.selection = { start: from + insert.length, end: from + insert.length };
      props.onChange({ value: props.value.slice(0, from) + insert + props.value.slice(to), selection: editor.selection,
        references: [{ ...reference, from, to: from + text.length, text }], interactions: [], markerObjects: [], fromPaste: false, insertedText: insert });
    }, getValue: () => props.value, getSelection: () => editor.selection,
    insertText: text => {
      const next = props.value.slice(0, editor.selection.start) + text + props.value.slice(editor.selection.end);
      const position = editor.selection.start + text.length; editor.selection = { start: position, end: position };
      props.onChange({ value: next, selection: editor.selection, references: [], interactions: [], markerObjects: [], fromPaste: false, insertedText: text });
    }, focus: () => {}, blur: () => {}, isFocused: () => true, caretCoords: () => null, replaceRange: (from, to, insert) => { editor.selection = { start: from + insert.length, end: from + insert.length }; props.onChange({ value: props.value.slice(0, from) + insert + props.value.slice(to), selection: editor.selection, references: [], interactions: [], markerObjects: [], fromPaste: false, insertedText: insert }); }, selectAll: () => {},
    setSelection: (start, end = start) => { editor.selection = { start, end }; },
  }));
  return <textarea aria-label="editor" value={props.value} placeholder={props.suggestion ?? props.placeholder}
    onInput={event => props.onChange({ value: event.currentTarget.value, selection: editor.selection, references: [], interactions: [], markerObjects: [], fromPaste: false, insertedText: '' })} />;
}) }));

let root: Root; let container: HTMLDivElement;
let sent: string[];
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  editor.selection = { start: 0, end: 0 }; sent = []; editor.menuKey.mockReset(); editor.registrations = []; editor.commandProps = undefined;
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

function Harness({ initial = '', workspace = true, actions, identityKey = 'original', composerKey, backendIdentity, backendCommands, external, onDraftChange }: {
  initial?: string; workspace?: boolean; actions?: Record<string, ComposerCommandAction | undefined>; identityKey?: string;
  external?: React.ComponentProps<typeof ThreadComposer>['external'];
  composerKey?: string; backendIdentity?: string; backendCommands?: React.ComponentProps<typeof ThreadComposer>['backendCommands'];
  onDraftChange?(value: string): void;
}) {
  const [value, setValue] = React.useState(initial);
  const [references, setReferences] = React.useState<readonly ComposerReference[]>([]);
  const [suggestion, setSuggestion] = React.useState<string | undefined>('好，继续完善吧');
  return <form ref={form => { if (form) form.requestSubmit = () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }; }}
    onSubmit={event => { event.preventDefault(); sent.push(value); }}>
    <ThreadComposer key={composerKey} commandActions={actions} identityKey={identityKey} backendIdentity={backendIdentity} backendCommands={backendCommands} external={external} backendControls={external ? <span>External harness</span> : undefined}
      editorRef={null} value={value} references={references} onChange={(next, nextReferences) => { setValue(next); setReferences(nextReferences ?? []); onDraftChange?.(next); }} suggestion={suggestion} onSuggestionDismiss={() => setSuggestion(undefined)}
      models={[]} providerId="provider" modelId="model" thinkingLevel="off" onModelChange={() => {}}
      modelDisabled={false} attachmentDisabled={false} imageDisabled={false} sendDisabled={false} pending={false} active={false} retrying={false}
      onFiles={() => {}} onAttachImages={() => {}} onAttachPdfs={() => {}}
      onGoal={() => {}} hasInput={Boolean(value.trim())} onWorkspace={workspace ? () => {} : undefined} workspaceLabel="Project" attachmentNames={[]} skills={[]} />
  </form>;
}
async function key(key: string, extra: Partial<KeyboardEvent> = {}) {
  let handled = false;
  await act(async () => { handled = editor.props!.onKeyDown!({ key, preventDefault() {}, stopPropagation() {}, ...extra } as KeyboardEvent); });
  return handled;
}

it('omits the workspace action when the conversation does not offer project selection', async () => {
  await act(async () => root.render(<Harness workspace={false} />));
  expect(container.querySelector('button[title="Project"]')).toBeNull();
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('button[title="Project"]')).not.toBeNull();
});

it('keeps the suggestion out of the draft until Tab accepts it', async () => {
  await act(async () => root.render(<Harness />));
  expect(editor.props!.value).toBe(''); expect(editor.props!.suggestion).toBe('好，继续完善吧');
  expect(await key('Tab')).toBe(true);
  expect(editor.props!.value).toBe('好，继续完善吧'); expect(editor.props!.suggestion).toBeUndefined(); expect(sent).toEqual([]);
  expect(await key('Tab')).toBe(false);
  await act(async () => {
    editor.selection = { start: 0, end: 0 };
    editor.props!.onChange({ value: '', selection: editor.selection, references: [], interactions: [], markerObjects: [], fromPaste: false, insertedText: '' });
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
  await act(async () => editor.props!.onChange({ value, selection: { start: value.length, end: value.length }, references: [], interactions: [], markerObjects: [], fromPaste: false, insertedText: value }));
  expect(container.textContent).not.toContain('chat.suggestion.insertHint');
  await key('Tab'); expect(editor.menuKey).toHaveBeenCalledWith('Tab'); expect(editor.props!.value).toBe(value);
});

it('keeps an explicitly dismissed suggestion closed', async () => {
  await act(async () => root.render(<Harness />));
  expect(await key('Escape')).toBe(true);
  expect(editor.props!.suggestion).toBeUndefined();
  expect(await key('Tab')).toBe(false);
});

function command(name = 'compact'): WorkbenchCommandRegistration {
  return { contributionId: `varin.builtin.composer.${name}`, meta: { commandId: `composer.${name}`, composer: { name, group: 'context', interaction: 'action' }, icon: 'command', keywords: [], order: 1 },
    implementation: { isAvailable: context => Boolean(context.composer?.actions[name]), execute: async context => { await context.composer?.actions[name]?.run?.(); } } };
}
async function type(value: string, position = value.length, references: readonly ComposerReference[] = []) {
  editor.selection = { start: position, end: position };
  await act(async () => editor.props!.onChange({ value, selection: editor.selection, references, interactions: [], markerObjects: [], fromPaste: false, insertedText: value }));
}
it('a selected application action consumes only its fragment, while Tab only completes it', async () => {
  editor.registrations = [command()]; const execute = vi.fn();
  await act(async () => root.render(<Harness actions={{ compact: { run: execute } }} />));
  await type('前文 /comp 后文', 8);
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands[0], 'complete'));
  expect(execute).not.toHaveBeenCalled(); expect(editor.props!.value).toBe('前文 /compact  后文'); expect(sent).toEqual([]);
  await type('前文 /compact 后文', 11);
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands[0], 'confirm'));
  expect(execute).toHaveBeenCalledTimes(1); expect(editor.props!.value).toBe('前文  后文'); expect(sent).toEqual([]);
});
it('only a whole registered invocation executes, and failures and unavailable invocations remain drafts', async () => {
  editor.registrations = [command()]; const execute = vi.fn(async () => { throw new Error('original failure'); });
  await act(async () => root.render(<Harness actions={{ compact: { run: execute } }} initial="/compact" />));
  await key('Enter'); expect(execute).toHaveBeenCalledTimes(1); expect(sent).toEqual([]); expect(editor.props!.value).toBe('/compact'); expect(container.textContent).toContain('original failure');
  await act(async () => root.render(<Harness key="unavailable" initial="/compact" />));
  await key('Enter'); expect(sent).toEqual([]); expect(editor.props!.value).toBe('/compact');
  await act(async () => root.render(<Harness key="prose" initial="请解释 /compact" actions={{ compact: { run: execute } }} />));
  await key('Enter'); expect(sent).toEqual(['请解释 /compact']); expect(execute).toHaveBeenCalledTimes(1);
});
it('an old asynchronous action cannot consume a newer source draft', async () => {
  editor.registrations = [command()]; let finish!: () => void; const execute = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => root.render(<Harness initial="/compact" actions={{ compact: { run: execute } }} />));
  await key('Enter');
  await act(async () => root.render(<Harness initial="/compact" identityKey="new-source" actions={{ compact: { run: execute } }} />));
  await type('new draft'); await act(async () => finish());
  expect(editor.props!.value).toBe('new draft'); expect(sent).toEqual([]);
});

it.each(['confirm', 'complete'] as const)('ignores an exiting menu %s callback after the source or draft changes', async mode => {
  editor.registrations = [command()]; const execute = vi.fn();
  const actions = { compact: { run: execute } };
  await act(async () => root.render(<Harness identityKey="old" actions={actions} />));
  await type('original /compact');
  const stale = editor.commandProps!;
  await act(async () => root.render(<Harness identityKey="new" actions={actions} />));
  // Keep identical text: the source guard must work independently of draft equality.
  await act(async () => stale.onCommandSelect(stale.additionalCommands[0], mode));
  expect(editor.props!.value).toBe('original /compact'); expect(execute).not.toHaveBeenCalled();
  await type('original /compact');
  const beforeEdit = editor.commandProps!;
  await type('new private draft');
  await act(async () => beforeEdit.onCommandSelect(beforeEdit.additionalCommands[0], mode));
  expect(editor.props!.value).toBe('new private draft'); expect(execute).not.toHaveBeenCalled(); expect(sent).toEqual([]);
});

it('opens a whole content command after Tab completion has closed its menu', async () => {
  editor.registrations = [command('model')];
  await act(async () => root.render(<Harness />));
  await type('/mod');
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands[0], 'complete'));
  expect(editor.props!.value).toBe('/model '); expect(editor.commandProps).toBeUndefined();
  await key('Enter');
  expect(container.textContent).toContain('composer.model.scope'); expect(sent).toEqual([]);
});

it.each([false, true])('completing navigation after unmount preserves the persisted draft (edited: %s)', async edited => {
  editor.registrations = [command('new')];
  let finish!: () => void; let persisted = '';
  const execute = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => root.render(<Harness actions={{ new: { run: execute } }} onDraftChange={value => { persisted = value; }} />));
  await type('original /new');
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands[0], 'confirm'));
  expect(execute).toHaveBeenCalledTimes(1);
  if (edited) await type('original /new later edits');
  await act(async () => root.render(null));
  await act(async () => finish());
  expect(persisted).toBe(edited ? 'original /new later edits' : 'original '); expect(sent).toEqual([]);
});

it.each(['original', 'other-harness:session', undefined])('retains backend command ownership across edits and remount into %s', async destination => {
  editor.registrations = [command()]; const execute = vi.fn();
  const actions = { compact: { run: execute } };
  const backendCommands = [{ name: 'compact', description: 'Harness compact' }];
  await act(async () => root.render(<Harness actions={actions} backendIdentity="original" backendCommands={backendCommands} />));
  await type('/comp');
  const backend = editor.commandProps!.additionalCommands.find(item => item.source === 'backend')!;
  await act(async () => editor.commandProps!.onCommandSelect(backend, 'confirm'));
  expect(editor.props!.value).toBe('/compact ');
  const selected = editor.props!.references!;
  expect(selected[0].target).toEqual({ kind: 'backend-command', name: 'compact', backend: 'original' });
  // The editor reports the unchanged binding when only trailing whitespace is removed.
  await type('/compact', '/compact'.length, selected);
  await act(async () => root.render(<Harness composerKey="remounted" actions={actions} backendIdentity={destination} backendCommands={backendCommands} />));
  await key('Enter');
  expect(execute).not.toHaveBeenCalled(); expect(editor.props!.value).toBe('/compact');
  expect(sent).toEqual(destination === 'original' ? ['/compact'] : []);
  if (destination !== 'original') expect(container.textContent).toContain('composer.scope.changed');
});


it('keeps external /model and /mode layers separate from same-named backend commands', async () => {
  editor.registrations = [command('model'), command('thinking'), command('permissions'), command('goal'), command('compact')];
  const change = vi.fn(), interact = vi.fn();
  const external: NonNullable<React.ComponentProps<typeof ThreadComposer>['external']> = {
    capabilities: { resume: true, images: false, steering: false, models: [{ id: 'one', name: 'First external', thinkingLevels: ['low', 'high'] }, { id: 'two', name: 'Second external' }], current: { model: 'one', mode: 'plan' }, modes: [{ id: 'plan', name: 'Plan backend' }] },
    source: 'live', choice: {}, onChange: change, onInteract: interact,
  };
  await act(async () => root.render(<Harness external={external} backendIdentity="agent:session" backendCommands={[{ name: 'model', description: 'Agent model command' }, { name: 'mode', description: 'Agent mode command' }]} />));
  await type('/mod');
  expect(editor.commandProps!.additionalCommands.filter(item => item.name === 'model').map(item => item.source)).toEqual(['varin', 'backend']);
  expect(editor.commandProps!.additionalCommands.filter(item => item.name === 'mode').map(item => item.source)).toEqual(['varin', 'backend']);
  expect(editor.commandProps!.additionalCommands.some(item => ['permissions', 'goal', 'compact'].includes(item.name))).toBe(false);
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands.find(item => item.name === 'model' && item.source === 'varin')!, 'confirm'));
  expect(interact).toHaveBeenCalledWith('menu');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Second external')!.click());
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ model: 'two' })); expect(editor.props!.value).toBe(''); expect(sent).toEqual([]);
  await type('/mod');
  await act(async () => editor.commandProps!.onCommandSelect(editor.commandProps!.additionalCommands.find(item => item.name === 'model' && item.source === 'backend')!, 'confirm'));
  expect(editor.props!.value).toBe('/model '); expect(sent).toEqual([]);
  await key('Enter'); expect(sent).toEqual(['/model ']);
});

it('starts external preparation on focus or typing but not while mounting the composer', async () => {
  const interact = vi.fn();
  await act(async () => root.render(<Harness external={{ choice: {}, onChange: () => {}, onInteract: interact }} />));
  expect(interact).not.toHaveBeenCalled();
  await act(async () => editor.props!.onFocus?.()); expect(interact).toHaveBeenLastCalledWith('focus');
  await type('hello'); expect(interact).toHaveBeenLastCalledWith('input');
});
