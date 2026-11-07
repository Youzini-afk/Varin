import React from 'react';
import { ComposerClosedError, interactionRanges, interactionHistory, setInteractionRanges, interactionInsertion, type InteractionRange } from './interactionRanges';
import { composerReferences, referenceHistory, setComposerReferences, addComposerReference, type ComposerReference } from './references';
import { history, isolateHistory, historyKeymap, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
  type KeyBinding,
} from '@codemirror/view';
import { cn } from '@/lib/utils';
import type { ComposerLanguageContext } from '../language/tokenize';
import { composerLanguage, setLanguageContext, readLanguageContext } from './composerLanguage';
import { imageReferenceTextChanges } from '@/lib/images/references';
import { handleComposerHostMouseDown } from './hostMouseDown';
import { composerEditorTheme, composerNativeSelectionExtension } from './theme';

export interface ComposerSelection {
  start: number;
  end: number;
}

export interface ComposerChange {
  value: string;
  selection: ComposerSelection;
  fromPaste: boolean;
  insertedText: string;
  references: readonly ComposerReference[];
  interactions: readonly InteractionRange[];
}

export interface ComposerEditorHandle {
  /** A paste destination that follows edits while attachment bytes are being read. */
  composeInteraction(sourceKey: string, text: string, isCurrent?: () => boolean): Promise<{ updated: boolean }>;
  captureInsertion(): { insertText(text: string): void; dispose(): void };
  blur(): void;
  caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
  focus(options?: { preventScroll?: boolean }): void;
  getSelection(): ComposerSelection;
  getValue(): string;
  insertText(text: string): void;
  insertReference(from: number, to: number, text: string, reference: Omit<ComposerReference, 'from' | 'to' | 'text'>): void;
  isFocused(): boolean;
  replaceRange(from: number, to: number, text: string, caret?: number): void;
  selectAll(): void;
  setSelection(start: number, end?: number): void;
}

interface ComposerEditorProps {
  value: string;
  references?: readonly ComposerReference[];
  interactions?: readonly InteractionRange[];
  autocomplete?: { id: string; activeId?: string };
  onChange(change: ComposerChange): void;
  onSelectionChange?(selection: ComposerSelection): void;
  onKeyDown?(event: KeyboardEvent): boolean;
  onFocus?(): void;
  onBlur?(): void;
  onPaste?(event: ClipboardEvent): void;
  languageContext: ComposerLanguageContext;
  placeholder?: string;
  suggestion?: string;
  editable?: boolean;
  fillContainer?: boolean;
  maxLines?: number;
  className?: string;
  spellCheck?: boolean;
  'aria-label'?: string;
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

const readSelection = (state: EditorState): ComposerSelection => {
  const range = state.selection.main;
  return { start: range.from, end: range.to };
};

const insertedTextOf = (transaction: {
  changes: {
    iterChanges(callback: (
      fromA: number,
      toA: number,
      fromB: number,
      toB: number,
      inserted: { toString(): string },
    ) => void): void;
  };
}): string => {
  let inserted = '';
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
    inserted += text.toString();
  });
  return inserted;
};

const isDeferredSyntheticEvent = (event: KeyboardEvent): boolean => (
  Boolean((event as KeyboardEvent & { synthetic?: boolean }).synthetic)
);

export const ComposerEditor = React.forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    const {
      value,
      languageContext,
      placeholder,
      suggestion,
      editable = true,
      fillContainer = false,
      maxLines = 8,
      className,
      spellCheck = false,
    } = props;
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const viewRef = React.useRef<EditorView | null>(null);
    const insertions = React.useRef(new Set<{ from: number; to: number }>());
    const composition = React.useRef(false);
    const knownCursor = React.useRef(false);
    const deferred = React.useRef<Array<{ run(): void; reject(reason: Error): void }>>([]);
    const handlersRef = React.useRef(props);
    const lastRealEnterShiftRef = React.useRef(false);
    handlersRef.current = props;

    React.useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const pendingInsertions = insertions.current;
      const pendingCompositions = deferred.current;

      const interceptKeys: KeyBinding[] = [{
        any: (_view, event) => {
          if (event.key === 'Enter' && isDeferredSyntheticEvent(event) && lastRealEnterShiftRef.current) {
            Object.defineProperty(event, 'shiftKey', { value: true });
          }
          return handlersRef.current.onKeyDown?.(event) ?? false;
        },
      }];
      const view = new EditorView({
        state: EditorState.create({
          doc: handlersRef.current.value,
          extensions: [
            history(),
            composerReferences.init(() => (handlersRef.current.references ?? []).filter(item => item.from >= 0 && item.to <= handlersRef.current.value.length && item.from < item.to && handlersRef.current.value.slice(item.from, item.to) === item.text)),
            referenceHistory,
            interactionRanges.init(() => handlersRef.current.interactions ?? []),
            interactionHistory,
            drawSelection(),
            composerNativeSelectionExtension,
            EditorView.lineWrapping,
            Prec.highest(keymap.of(interceptKeys)),
            keymap.of([...standardKeymap, ...historyKeymap]),
            composerLanguage(handlersRef.current.languageContext),
            editableCompartment.of(EditorView.editable.of(handlersRef.current.editable ?? true)),
            placeholderCompartment.of(placeholderExtension(handlersRef.current.suggestion ?? handlersRef.current.placeholder ?? '')),
            composerEditorTheme,
            EditorView.updateListener.of((update) => {
              const handlers = handlersRef.current;
              const selection = readSelection(update.state);
              if (update.docChanged) {
                for (const insertion of pendingInsertions) {
                  const collapsed = insertion.from === insertion.to;
                  // Once the user edits the selected text, the delayed paste must not
                  // replace that new work. Keep only an insertion point after it.
                  if (!collapsed && update.changes.touchesRange(insertion.from, insertion.to)) {
                    insertion.from = insertion.to = update.changes.mapPos(insertion.to, 1);
                    continue;
                  }
                  const from = update.changes.mapPos(insertion.from, collapsed ? -1 : 1);
                  insertion.to = Math.max(from, update.changes.mapPos(insertion.to, -1));
                  insertion.from = from;
                }
                handlers.onChange({
                  value: update.state.doc.toString(),
                  selection,
                  fromPaste: update.transactions.some((transaction) => transaction.isUserEvent('input.paste')),
                  insertedText: update.transactions.map(insertedTextOf).join(''),
                  references: update.state.field(composerReferences),
                  interactions: update.state.field(interactionRanges),
                });
              } else if (update.selectionSet) {
                knownCursor.current = true;
                handlers.onSelectionChange?.(selection);
              }
            }),
            EditorView.domEventHandlers({
              blur: () => { handlersRef.current.onBlur?.(); return false; },
              focus: () => { knownCursor.current = true; handlersRef.current.onFocus?.(); return false; },
              compositionstart: () => { composition.current = true; return false; },
              compositionend: () => {
                composition.current = false;
                // Let CodeMirror apply the final IME transaction before inserting.
                setTimeout(() => { if (!composition.current) for (const pending of pendingCompositions.splice(0)) pending.run(); }, 0);
                return false;
              },
              paste: (event) => { handlersRef.current.onPaste?.(event); return false; },
            }),
            EditorView.contentAttributes.of({
              spellcheck: String(handlersRef.current.spellCheck ?? false),
              autocorrect: 'off',
              autocapitalize: 'none',
              ...(handlersRef.current['aria-label']
                ? { 'aria-label': handlersRef.current['aria-label'] }
                : {}),
            }),
          ] satisfies Extension[],
        }),
        parent: host,
      });
      viewRef.current = view;

      const trackRealEnterShift = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || isDeferredSyntheticEvent(event)) return;
        lastRealEnterShiftRef.current = event.shiftKey;
      };
      view.contentDOM.addEventListener('keydown', trackRealEnterShift);
      return () => {
        view.contentDOM.removeEventListener('keydown', trackRealEnterShift);
        viewRef.current = null;
        pendingInsertions.clear();
        for (const pending of pendingCompositions.splice(0)) pending.reject(new ComposerClosedError(knownCursor.current ? view.state.selection.main.head : view.state.doc.length));
        composition.current = false;
        view.destroy();
      };
    }, []);

    // A controlled change (a send clearing the draft) lands in the same commit
    // as the rest of the composer, so no frame paints the old text beside it.
    React.useLayoutEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      // External append/quote/dictation changes are still local edits: keep unrelated
      // reference bindings, selection mapping and undo rather than replacing the document.
      let from = 0;
      while (from < current.length && from < value.length && current[from] === value[from]) from++;
      let to = current.length, end = value.length;
      while (to > from && end > from && current[to - 1] === value[end - 1]) { to--; end--; }
      const imageChanges = imageReferenceTextChanges(current, value);
      const relabeled = imageChanges && JSON.stringify(readLanguageContext(view).imageReferences) !== JSON.stringify(handlersRef.current.languageContext.imageReferences);
      view.dispatch({ changes: imageChanges ?? { from, to, insert: value.slice(from, end) },
        ...(relabeled ? { annotations: Transaction.addToHistory.of(false) } : {}) });
      requestAnimationFrame(() => {
        if (viewRef.current === view) view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      });
    }, [value]);

    React.useLayoutEffect(() => {
      const view = viewRef.current;
      if (!view || props.references === undefined || JSON.stringify(view.state.field(composerReferences)) === JSON.stringify(props.references)) return;
      view.dispatch({ effects: setComposerReferences.of(props.references), annotations: Transaction.addToHistory.of(false) });
    }, [props.references, value]);

    React.useLayoutEffect(() => {
      viewRef.current?.dispatch({ effects: setLanguageContext.of(languageContext) });
    }, [languageContext]);

    React.useEffect(() => {
      viewRef.current?.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
      });
    }, [editable]);

    React.useEffect(() => {
      viewRef.current?.dispatch({
        effects: placeholderCompartment.reconfigure(placeholderExtension(suggestion ?? placeholder ?? '')),
      });
    }, [placeholder, suggestion]);

    React.useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (fillContainer) {
        view.scrollDOM.style.maxHeight = '';
        view.scrollDOM.style.height = '100%';
        return;
      }
      view.scrollDOM.style.height = '';
      const applyLimit = () => {
        const lineHeight = Number.parseFloat(getComputedStyle(view.contentDOM).lineHeight || '');
        if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
        view.scrollDOM.style.maxHeight = `${lineHeight * maxLines}px`;
      };
      applyLimit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(applyLimit);
      observer.observe(view.dom);
      return () => observer.disconnect();
    }, [fillContainer, maxLines]);

    React.useEffect(() => {
      const content = viewRef.current?.contentDOM;
      if (content) content.setAttribute('spellcheck', String(spellCheck));
    }, [spellCheck]);

    React.useEffect(() => {
      const content = viewRef.current?.contentDOM;
      if (!content) return;
      content.setAttribute('role', 'combobox');
      content.setAttribute('aria-autocomplete', 'list');
      content.setAttribute('aria-expanded', String(Boolean(props.autocomplete)));
      if (props.autocomplete) content.setAttribute('aria-controls', props.autocomplete.id);
      else content.removeAttribute('aria-controls');
      if (props.autocomplete?.activeId) content.setAttribute('aria-activedescendant', props.autocomplete.activeId);
      else content.removeAttribute('aria-activedescendant');
    }, [props.autocomplete]);

    React.useLayoutEffect(() => {
      const view = viewRef.current;
      if (view && props.interactions !== undefined && JSON.stringify(view.state.field(interactionRanges)) !== JSON.stringify(props.interactions)) {
        view.dispatch({ effects: setInteractionRanges.of(props.interactions), annotations: Transaction.addToHistory.of(false) });
      }
    }, [props.interactions, value]);

    React.useImperativeHandle(ref, (): ComposerEditorHandle => ({
      composeInteraction(sourceKey, text, isCurrent) {
        return new Promise((resolve, reject) => {
          const run = () => {
            const view = viewRef.current;
            if (!view) { reject(new Error('Composer closed')); return; }
            if (isCurrent && !isCurrent()) { reject(new Error('Interaction source changed')); return; }
            const insertion = interactionInsertion(view.state.doc.toString(), view.state.field(interactionRanges), sourceKey, text,
              knownCursor.current ? view.state.selection.main.head : view.state.doc.length);
            view.dispatch(insertion.spec);
            resolve({ updated: insertion.updated });
          };
          if (composition.current || viewRef.current?.composing) deferred.current.push({ run, reject });
          else run();
        });
      },
      insertReference(from, to, text, reference) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from, to, insert: `${text} ` }, selection: { anchor: from + text.length + 1 },
          effects: addComposerReference.of({ ...reference, from, to: from + text.length, text }), annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
      },
      captureInsertion() {
        const view = viewRef.current;
        const range = view?.state.selection.main;
        const insertion = { from: range?.from ?? 0, to: range?.to ?? 0 };
        insertions.current.add(insertion);
        return {
          dispose: () => { insertions.current.delete(insertion); },
          insertText(text) {
            if (!view || viewRef.current !== view || !insertions.current.has(insertion) || !text) return;
            const { from, to } = insertion;
            const selection = view.state.selection.main;
            const follows = selection.from === from && selection.to === to;
            view.dispatch({ changes: { from, to, insert: text },
              ...(follows ? { selection: { anchor: from + text.length } } : {}), userEvent: 'input.paste' });
            insertion.from = insertion.to = from + text.length;
          },
        };
      },
      blur: () => viewRef.current?.contentDOM.blur(),
      caretCoords(position) {
        const view = viewRef.current;
        if (!view) return null;
        const coords = view.coordsAtPos(position ?? view.state.selection.main.head);
        return coords ? { bottom: coords.bottom, left: coords.left, top: coords.top } : null;
      },
      focus: (options) => viewRef.current?.contentDOM.focus({ preventScroll: options?.preventScroll }),
      getSelection: () => viewRef.current ? readSelection(viewRef.current.state) : { end: 0, start: 0 },
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      insertText(text) {
        const view = viewRef.current;
        if (!view || !text) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, insert: text, to },
          selection: { anchor: from + text.length },
          userEvent: 'input.type',
        });
      },
      isFocused: () => viewRef.current?.hasFocus ?? false,
      replaceRange(from, to, text, caret) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from, insert: text, to },
          selection: { anchor: caret ?? from + text.length },
          userEvent: 'input.type',
        });
      },
      selectAll() {
        const view = viewRef.current;
        if (view) view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      },
      setSelection(start, end = start) {
        const view = viewRef.current;
        if (!view) return;
        const max = view.state.doc.length;
        view.dispatch({
          selection: {
            anchor: Math.min(Math.max(start, 0), max),
            head: Math.min(Math.max(end, 0), max),
          },
        });
      },
    }), []);

    return (
      <div
        ref={hostRef}
        data-chat-input="true"
        data-composer-suggestion={suggestion ? 'true' : undefined}
        onMouseDown={(event) => handleComposerHostMouseDown(viewRef.current, event)}
        className={cn(
          'composer-editor w-full [&_.cm-editor]:h-full',
          fillContainer && 'flex min-h-0 flex-1 flex-col',
          className,
        )}
      />
    );
  },
);
