import React from 'react';
import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
  type KeyBinding,
} from '@codemirror/view';
import { cn } from '@/lib/utils';
import type { ComposerLanguageContext } from '../language/tokenize';
import { composerLanguage, setLanguageContext } from './composerLanguage';
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
}

export interface ComposerEditorHandle {
  blur(): void;
  caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
  focus(options?: { preventScroll?: boolean }): void;
  getSelection(): ComposerSelection;
  getValue(): string;
  insertText(text: string): void;
  isFocused(): boolean;
  replaceRange(from: number, to: number, text: string, caret?: number): void;
  selectAll(): void;
  setSelection(start: number, end?: number): void;
}

interface ComposerEditorProps {
  value: string;
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
    const handlersRef = React.useRef(props);
    const lastRealEnterShiftRef = React.useRef(false);
    handlersRef.current = props;

    React.useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;

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
                handlers.onChange({
                  value: update.state.doc.toString(),
                  selection,
                  fromPaste: update.transactions.some((transaction) => transaction.isUserEvent('input.paste')),
                  insertedText: update.transactions.map(insertedTextOf).join(''),
                });
              } else if (update.selectionSet) {
                handlers.onSelectionChange?.(selection);
              }
            }),
            EditorView.domEventHandlers({
              blur: () => { handlersRef.current.onBlur?.(); return false; },
              focus: () => { handlersRef.current.onFocus?.(); return false; },
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
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: value.length },
      });
      requestAnimationFrame(() => {
        if (viewRef.current === view) view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      });
    }, [value]);

    React.useEffect(() => {
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

    React.useImperativeHandle(ref, (): ComposerEditorHandle => ({
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
