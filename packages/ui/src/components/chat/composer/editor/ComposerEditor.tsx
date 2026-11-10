import React from 'react';
import { ComposerClosedError, interactionRanges, interactionHistory, setInteractionRanges, interactionInsertion, type InteractionRange } from './interactionRanges';
import { composerReferences, referenceHistory, setComposerReferences, addComposerReference, composerMarkerObjectId, type ComposerReference } from './references';
import { history, isolateHistory, historyKeymap, standardKeymap } from '@codemirror/commands';
import { ChangeSet, Compartment, EditorState, Prec, StateEffect, Transaction, type Extension, type TransactionSpec } from '@codemirror/state';
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
import { imageReferenceTextChanges } from '@/lib/images/references';
import { composerMarkerObjects, sameComposerMarkerObjects, setComposerMarkerObjects, markerObjectHistory, atomicMarkerEditing, insertComposerMarker, replaceComposerMarkerObjects, type ComposerMarkerObject } from './markers';
import { composerMarkerClipboard } from './markerClipboard';
import { composerMarkerDrag } from './markerDrag';
import { registerMarkerComposer } from './markerComposerRegistry';
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
  markerObjects: readonly ComposerMarkerObject[];
}

export interface ComposerMarkerInsertion { insertMarker(object: ComposerMarkerObject): Promise<void>; dispose(): void }

export interface ComposerEditorHandle {
  captureMarkerInsertion(): ComposerMarkerInsertion;
  insertMarker(object: ComposerMarkerObject): Promise<void>;
  removeMarkerObject(id: string): void;
  replaceMarkerObjects(objects: readonly ComposerMarkerObject[], options?: { renumber?: boolean; addToHistory?: boolean }): void;
  getEditorState(): EditorState | undefined;
  /** A paste destination that follows edits while attachment bytes are being read. */
  composeInteraction(sourceKey: string, text: string, isCurrent?: () => boolean, options?: { position?: number; marker?: ComposerMarkerObject; replaceMarkerId?: string }): Promise<{ updated: boolean }>;
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
  draftKey?: string;
  host?: number;
  markerObjects?: readonly ComposerMarkerObject[];
  editorState?: EditorState;
  onEditorStateChange?(state: EditorState): void;
  onMarkerActivate?(object: ComposerMarkerObject): void;
  onMarkerError?(message: string): void;
  validateMarkerPaste?(objects: readonly ComposerMarkerObject[]): string | undefined;
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

const historyCompartment = new Compartment();
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
    const insertions = React.useRef(new Set<{ from: number; to: number; marker?: boolean }>());
    const previousEditorState = React.useRef(props.editorState);
    const handleRef = React.useRef<ComposerEditorHandle | null>(null);
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
        any: (view, event) => {
          const marker = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-composer-marker]') : null;
          if ((event.key === 'Enter' || event.key === ' ') && marker && view.dom.ownerDocument.activeElement === marker) {
            const reference = view.state.field(composerReferences).find(item => item.id === marker.dataset.composerReference);
            const object = reference && view.state.field(composerMarkerObjects).find(item => item.id === composerMarkerObjectId(reference));
            if (object) { event.preventDefault(); event.stopPropagation(); handlersRef.current.onMarkerActivate?.(object); return true; }
          }
          if (event.key === 'Enter' && isDeferredSyntheticEvent(event) && lastRealEnterShiftRef.current) {
            Object.defineProperty(event, 'shiftKey', { value: true });
          }
          return handlersRef.current.onKeyDown?.(event) ?? false;
        },
      }];
      const extensions = [
            historyCompartment.of(history()),
            composerReferences.init(() => (handlersRef.current.references ?? []).filter(item => item.from >= 0 && item.to <= handlersRef.current.value.length && item.from < item.to && handlersRef.current.value.slice(item.from, item.to) === item.text)),
            referenceHistory,
            composerMarkerObjects.init(() => handlersRef.current.markerObjects ?? []), markerObjectHistory, atomicMarkerEditing,
            composerMarkerClipboard({ host: () => handlersRef.current.host, onError: message => handlersRef.current.onMarkerError?.(message), validate: objects => handlersRef.current.validateMarkerPaste?.(objects) }),
            composerMarkerDrag({ isComposing: () => composition.current, onOpen: reference => {
              const object = viewRef.current?.state.field(composerMarkerObjects).find(object => object.id === composerMarkerObjectId(reference));
              if (object) handlersRef.current.onMarkerActivate?.(object);
            } }),
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
              }
              const markerChanged = update.startState.field(composerMarkerObjects) !== update.state.field(composerMarkerObjects);
              if (update.docChanged || markerChanged) {
                handlers.onChange({
                  value: update.state.doc.toString(),
                  selection,
                  fromPaste: update.transactions.some((transaction) => transaction.isUserEvent('input.paste')),
                  insertedText: update.transactions.map(insertedTextOf).join(''),
                  references: update.state.field(composerReferences),
                  interactions: update.state.field(interactionRanges),
                  markerObjects: update.state.field(composerMarkerObjects),
                });
              }
              if (update.selectionSet) {
                knownCursor.current = true;
                handlers.onSelectionChange?.(selection);
              }
              if (update.docChanged || update.selectionSet || markerChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setComposerReferences) || effect.is(addComposerReference) || effect.is(setInteractionRanges)))) handlers.onEditorStateChange?.(update.state);
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
          ] satisfies Extension[];
      const restored = handlersRef.current.editorState;
      knownCursor.current = Boolean(restored);
      const state = restored && restored.doc.toString() === handlersRef.current.value
        ? restored.update({ effects: StateEffect.reconfigure.of(extensions), annotations: Transaction.addToHistory.of(false) }).state
        : EditorState.create({ doc: handlersRef.current.value, extensions });
      const view = new EditorView({ state, parent: host });
      viewRef.current = view;
      handlersRef.current.onEditorStateChange?.(view.state);

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

    // External draft commands enter the same transaction as their object/range changes.
    // Editor-originated updates already agree and do not produce duplicate undo events.
    React.useLayoutEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      const refsChanged = props.references !== undefined && JSON.stringify(view.state.field(composerReferences)) !== JSON.stringify(props.references);
      const objectsChanged = props.markerObjects !== undefined && (view.state.field(composerMarkerObjects) !== props.markerObjects)
        && !sameComposerMarkerObjects(view.state.field(composerMarkerObjects), props.markerObjects);
      if (current === value && !refsChanged && !objectsChanged) return;
      let from = 0;
      while (from < current.length && from < value.length && current[from] === value[from]) from++;
      let to = current.length, end = value.length;
      while (to > from && end > from && current[to - 1] === value[end - 1]) { to--; end--; }
      view.dispatch({ ...(current !== value ? { changes: imageReferenceTextChanges(current, value) ?? { from, to, insert: value.slice(from, end) } } : {}),
        effects: [...(refsChanged ? [setComposerReferences.of(props.references!)] : []), ...(objectsChanged ? [setComposerMarkerObjects.of(props.markerObjects!)] : [])],
        annotations: isolateHistory.of('full'), userEvent: 'input.draft', filter: false });
    }, [value, props.references, props.markerObjects]);

    React.useLayoutEffect(() => {
      const reset = previousEditorState.current !== undefined && props.editorState === undefined;
      previousEditorState.current = props.editorState;
      const view = viewRef.current;
      if (!reset || !view) return;
      // Acceptance/discard ends the prior draft's undo ownership. Keep any new unsent text,
      // but never revive a sent object after its resource holder has been released.
      view.dispatch({ effects: historyCompartment.reconfigure([]), annotations: Transaction.addToHistory.of(false) });
      view.dispatch({ effects: historyCompartment.reconfigure(history()), annotations: Transaction.addToHistory.of(false) });
      handlersRef.current.onEditorStateChange?.(view.state);
    }, [props.editorState]);

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

    React.useImperativeHandle(ref, (): ComposerEditorHandle => (handleRef.current = {
      getEditorState: () => viewRef.current?.state,
      captureMarkerInsertion() {
        const view = viewRef.current;
        const at = view ? (knownCursor.current ? view.state.selection.main.head : view.state.doc.length) : 0;
        const insertion = { from: at, to: at, marker: true };
        insertions.current.add(insertion);
        let active = true;
        return {
          dispose() { active = false; insertions.current.delete(insertion); },
          insertMarker(object) {
            return new Promise<void>((resolve, reject) => {
              const run = () => {
                if (!active) { reject(new Error('Insertion cancelled')); return; }
                if (!view || viewRef.current !== view) { reject(new ComposerClosedError(insertion.from)); return; }
                const from = insertion.from;
                const selection = view.state.selection.main;
                const spec = insertComposerMarker(view.state, object, from);
                if (selection.head !== from) delete spec.selection;
                view.dispatch(spec);
                const marker = view.state.field(composerReferences).find(reference => reference.from === from && composerMarkerObjectId(reference) === object.id);
                insertion.from = insertion.to = marker?.to ?? insertion.from;
                resolve();
              };
              if (composition.current || viewRef.current?.composing) deferred.current.push({ run, reject: reason => reject(reason instanceof ComposerClosedError ? new ComposerClosedError(insertion.from) : reason) });
              else run();
            });
          },
        };
      },
      async insertMarker(object) {
        const anchor = handleRef.current!.captureMarkerInsertion();
        try { await anchor.insertMarker(object); } finally { anchor.dispose(); }
      },
      replaceMarkerObjects(objects, options) {
        const view = viewRef.current;
        if (!view) return;
        const spec = replaceComposerMarkerObjects(view.state, objects, options);
        if (spec) view.dispatch({ ...spec, ...(options?.addToHistory === false ? { annotations: Transaction.addToHistory.of(false) } : {}) });
      },
      removeMarkerObject(id) {
        const view = viewRef.current;
        if (!view) return;
        const spec = replaceComposerMarkerObjects(view.state, view.state.field(composerMarkerObjects).filter(object => object.id !== id));
        if (spec) view.dispatch(spec);
      },
      composeInteraction(sourceKey, text, isCurrent, options) {
        const original = viewRef.current;
        const position = options?.position ?? (original ? knownCursor.current ? original.state.selection.main.head : original.state.doc.length : 0);
        const anchor = { from: position, to: position };
        insertions.current.add(anchor);
        return new Promise((resolve, reject) => {
          const fail = (reason: Error) => { insertions.current.delete(anchor); reject(reason instanceof ComposerClosedError ? new ComposerClosedError(anchor.from) : reason); };
          const run = () => {
            const view = viewRef.current;
            if (!view || view !== original) { fail(new ComposerClosedError(anchor.from)); return; }
            if (isCurrent && !isCurrent()) { fail(new Error('Interaction source changed')); return; }
            const insertion = interactionInsertion(view.state.doc.toString(), view.state.field(interactionRanges), sourceKey, text, anchor.from);
            let next = view.state;
            let changes = ChangeSet.empty(next.doc.length);
            const apply = (spec: TransactionSpec | null) => {
              if (!spec) return;
              const transaction = next.update(spec); changes = changes.compose(transaction.changes); next = transaction.state;
            };
            apply(insertion.spec);
            if (options?.marker) {
              if (insertion.updated && options.replaceMarkerId) apply(replaceComposerMarkerObjects(next, next.field(composerMarkerObjects).filter(object => object.id !== options.replaceMarkerId)));
              const range = next.field(interactionRanges).find(range => range.sourceKey === sourceKey);
              apply(insertComposerMarker(next, options.marker, range?.to ?? next.doc.length));
            }
            insertions.current.delete(anchor);
            view.dispatch({ changes, selection: next.selection, effects: [setComposerReferences.of(next.field(composerReferences)), setComposerMarkerObjects.of(next.field(composerMarkerObjects)), setInteractionRanges.of(next.field(interactionRanges))],
              annotations: isolateHistory.of('full'), userEvent: 'input.interaction', filter: false });
            resolve({ updated: insertion.updated });
          };
          if (composition.current || viewRef.current?.composing) deferred.current.push({ run, reject: fail });
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

    React.useLayoutEffect(() => props.draftKey && handleRef.current ? registerMarkerComposer(props.draftKey, handleRef.current) : undefined, [props.draftKey]);

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
