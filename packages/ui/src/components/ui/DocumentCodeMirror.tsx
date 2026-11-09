import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import React from 'react';
import { CodeMirrorEditor, type CodeMirrorTextChange } from '@/components/ui/CodeMirrorEditor';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useDocumentLanguageExtensions } from '@/lib/codemirror/language-client';
import {
  acquireLanguageDocument,
  notifyLanguageDocumentChange,
  notifyLanguageDocumentSave,
  releaseLanguageDocument,
} from '@/lib/language-services/session';
import { documentKey, type DocumentEditResult, type DocumentIdentity, type DocumentRecord } from '@/lib/documents/types';

/**
 * Document-bound CodeMirror projection for mobile and embedded workspace editors.
 * Desktop/Web Workbench file tabs use Monaco.
 */
type DocumentCodeMirrorProps = Omit<React.ComponentProps<typeof CodeMirrorEditor>, 'value' | 'onChange'> & {
  identity: DocumentIdentity | undefined;
  registry?: import('@/lib/documents/registry').DocumentRegistry;
};

type DocumentCodeMirrorRegistry = Pick<ReturnType<typeof getDocumentRegistry>, 'get' | 'applyEdits'>;

type DocumentCodeMirrorAdapterResult = DocumentEditResult | {
  status: 'unsupported';
  reason: 'document-not-open' | 'missing-changes';
  record?: DocumentRecord;
};

/** Adapt a CodeMirror transaction into the registry's incremental edit contract. */
// eslint-disable-next-line react-refresh/only-export-components
export const applyDocumentCodeMirrorChanges = (
  registry: DocumentCodeMirrorRegistry,
  identity: DocumentIdentity,
  changes: readonly CodeMirrorTextChange[] | undefined,
  origin: string,
  expectedLocalEditRevision: number,
  history?: 'undo' | 'redo',
): DocumentCodeMirrorAdapterResult => {
  const record = registry.get(identity);
  if (!record) return { status: 'unsupported', reason: 'document-not-open' };
  if (!changes || changes.length === 0) {
    return { status: 'unsupported', reason: 'missing-changes', record };
  }
  return registry.applyEdits(identity, {
    expectedLocalEditRevision,
    edits: changes.map(({ from, to, insert }) => ({ from, to, insert })),
    origin,
    ...(history ? { history } : {}),
  });
};

export const DocumentCodeMirror: React.FC<DocumentCodeMirrorProps> = ({
  identity,
  extensions,
  onViewDestroy,
  onViewReady,
  registry: scopedRegistry,
  ...editorProps
}) => {
  const origin = React.useId();
  const viewRef = React.useRef<import('@codemirror/view').EditorView | null>(null);
  const registry = scopedRegistry ?? getDocumentRegistry();
  const record = useDocumentRecord(identity, registry);
  const previousBaseRevisionRef = React.useRef<string | null | undefined>(record?.baseRevision);
  const previousSavingRef = React.useRef(record?.saving ?? false);
  const rejectedChangeRef = React.useRef<{ identityKey: string; attemptedValue: string } | null>(null);
  const previousIdentityRef = React.useRef(identity ? `${identity.workspaceId}\0${identity.resourceId}` : '');
  const activeIdentityKeyRef = React.useRef(previousIdentityRef.current);
  const projectedRevisionRef = React.useRef(record?.localEditRevision ?? 0);
  activeIdentityKeyRef.current = identity ? documentKey(identity) : '';
  const buffer = record?.buffer ?? '';
  const languageExtensions = useDocumentLanguageExtensions(scopedRegistry ? undefined : identity);

  React.useEffect(() => {
    if (!identity || scopedRegistry) return undefined;
    acquireLanguageDocument(identity);
    return () => releaseLanguageDocument(identity);
  }, [identity, scopedRegistry]);

  React.useEffect(() => {
    const identityKey = identity ? `${identity.workspaceId}\0${identity.resourceId}` : '';
    if (identityKey !== previousIdentityRef.current) {
      previousIdentityRef.current = identityKey;
      rejectedChangeRef.current = null;
      projectedRevisionRef.current = record?.localEditRevision ?? 0;
      previousBaseRevisionRef.current = record?.baseRevision;
      previousSavingRef.current = record?.saving ?? false;
      return;
    }
    const previous = previousBaseRevisionRef.current;
    const wasSaving = previousSavingRef.current;
    previousBaseRevisionRef.current = record?.baseRevision;
    previousSavingRef.current = record?.saving ?? false;
    if (!identity || !wasSaving || record?.saving || previous === undefined || previous === record?.baseRevision) return;
    if (!scopedRegistry) notifyLanguageDocumentSave(identity);
  }, [identity, record?.baseRevision, record?.localEditRevision, record?.saving, scopedRegistry]);

  React.useEffect(() => {
    projectedRevisionRef.current = record?.localEditRevision ?? 0;
  }, [identity, record?.localEditRevision]);

  const handleChange = React.useCallback((value: string, changes?: CodeMirrorTextChange[], history?: 'undo' | 'redo') => {
    if (!identity) return;
    const current = registry.get(identity);
    const identityKey = documentKey(identity);
    const rejected = rejectedChangeRef.current;
    // On a rejected edit CodeMirror receives the authoritative value through its
    // controlled prop. Ignore that one reconciliation transaction so it cannot
    // become a second edit or advance the revision in a loop.
    if (rejected && rejected.identityKey === identityKey && current && value === current.buffer) {
      rejectedChangeRef.current = null;
      return;
    }

    const result = applyDocumentCodeMirrorChanges(
      registry,
      identity,
      changes,
      origin,
      projectedRevisionRef.current,
      history,
    );
    switch (result.status) {
      case 'applied':
        projectedRevisionRef.current = result.record.localEditRevision;
        rejectedChangeRef.current = null;
        if (!scopedRegistry) notifyLanguageDocumentChange(identity);
        return;
      case 'stale':
      case 'invalid':
      case 'unsupported':
        // The registry remains authoritative; CodeMirror will reconcile from the
        // current buffer. Schedule the dispatch outside CodeMirror's update
        // listener; nested EditorView updates are not allowed.
        rejectedChangeRef.current = { identityKey, attemptedValue: value };
        if (result.record) {
          queueMicrotask(() => {
            const view = viewRef.current;
            const rejectedAttempt = rejectedChangeRef.current;
            const authoritativeValue = registry.get(identity)?.buffer ?? result.record?.buffer;
            if (
              !view
              || authoritativeValue === undefined
              || activeIdentityKeyRef.current !== identityKey
              || rejectedAttempt?.identityKey !== identityKey
              || rejectedAttempt.attemptedValue !== value
              || view.state.doc.toString() === authoritativeValue
            ) return;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: authoritativeValue },
            });
          });
        }
        return;
    }
  }, [identity, origin, registry, scopedRegistry]);

  const formatUndo = React.useMemo(() => Prec.highest(keymap.of([{ key: 'Mod-z', run: () => Boolean(identity && registry.undoFormat(identity)) }])), [identity, registry]);

  if (!identity) return null;

  return (
    <CodeMirrorEditor
      value={buffer}
      onChange={handleChange}
      extensions={[formatUndo, ...languageExtensions, ...(extensions ?? [])]}
      onViewReady={(view) => {
        viewRef.current = view;
        onViewReady?.(view);
      }}
      onViewDestroy={() => {
        viewRef.current = null;
        onViewDestroy?.();
      }}
      {...editorProps}
    />
  );
};
