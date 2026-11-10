import { ChangeSet, type TransactionSpec } from '@codemirror/state';
import { draftMarkerState, referenceMarkerObject, saveComposerState } from '@/lib/agent-editor/contentReferences';
import { insertComposerMarker, replaceComposerMarkerObjects, composerMarkerObjects, setComposerMarkerObjects } from '@/components/chat/composer/editor/markers';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ComposerClosedError, interactionInsertion, interactionRanges, setInteractionRanges } from '@/components/chat/composer/editor/interactionRanges';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { composerReferences, setComposerReferences } from '@/components/chat/composer/editor/references';
import { isolateHistory } from '@codemirror/commands';
import { releaseUiSelection } from './selection-lifetime';

export interface UiComposeInput { identity: ThreadIdentity; host: number; sourceKey: string; text: string; reference?: ContentReference; insertion?: UiComposeInsertion }
export interface UiComposeInsertion { readonly cursor: number; dispose(): void }
/** Capture the original draft caret before a frame or resource snapshot is read. */
export function beginUiComposeInsertion(identity: ThreadIdentity): UiComposeInsertion {
  const key = threadComposerKey(threadHostKey(), identity), store = useThreadDraftStore.getState();
  store.patch(key, {});
  const draft = useThreadDraftStore.getState().drafts[key], editor = composers.get(key);
  let cursor = editor?.getSelection().end ?? draft.editorState?.selection.main.head ?? draft.text.length;
  const unsubscribe = useThreadDraftStore.subscribe((next, previous) => {
    const before = previous.drafts[key]?.text ?? '', after = next.drafts[key]?.text ?? '';
    if (before === after) return;
    let from = 0, to = before.length, end = after.length;
    while (from < to && from < end && before[from] === after[from]) from++;
    while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
    cursor = ChangeSet.of({ from, to, insert: after.slice(from, end) }, before.length).mapPos(cursor, 1);
  });
  return { get cursor() { return cursor; }, dispose: unsubscribe };
}
export interface UiComposeReceipt { status: 'filled'; updated: boolean }
export interface UiSendReceipt { status: 'sent' | 'queued'; inputId?: string }
const composers = new Map<string, ComposerEditorHandle>();
const senders = new Map<string, (input: UiComposeInput) => Promise<UiSendReceipt>>();
subscribeRuntimeEndpointWillChange(() => { composers.clear(); senders.clear(); });
export function registerUiComposer(key: string, editor: ComposerEditorHandle) {
  composers.set(key, editor);
  return () => { if (composers.get(key) === editor) composers.delete(key); };
}
export function registerUiSender(key: string, send: (input: UiComposeInput) => Promise<UiSendReceipt>) {
  senders.set(key, send);
  return () => { if (senders.get(key) === send) senders.delete(key); };
}
function scope(input: UiComposeInput) {
  if (input.host !== getRuntimeEndpointGeneration()) throw new Error('Host changed; reopen this content.');
  if (!input.text.trim()) throw new Error('The interaction did not provide any text.');
  return threadComposerKey(threadHostKey(), input.identity);
}
function insertWithoutEditor(key: string, input: UiComposeInput, cursor?: number) {
  const draft = useThreadDraftStore.getState().drafts[key] ?? EMPTY_THREAD_DRAFT, state = draftMarkerState(draft);
  const insertion = interactionInsertion(draft.text, draft.interactions ?? [], input.sourceKey, input.text, cursor);
  let next = state, changes = ChangeSet.empty(state.doc.length);
  const apply = (spec: TransactionSpec | null) => {
    if (!spec) return;
    const transaction = next.update(spec); changes = changes.compose(transaction.changes); next = transaction.state;
  };
  apply(insertion.spec);
  if (input.reference) {
    const previous = draft.interactionAttachments?.[input.sourceKey];
    if (insertion.updated && previous && previous !== input.reference.ref) apply(replaceComposerMarkerObjects(next, next.field(composerMarkerObjects).filter(object => object.id !== previous)));
    const range = next.field(interactionRanges).find(range => range.sourceKey === input.sourceKey);
    apply(insertComposerMarker(next, referenceMarkerObject(input.reference), range?.to ?? next.doc.length));
  }
  saveComposerState(key, state.update({ changes, selection: next.selection, effects: [setComposerReferences.of(next.field(composerReferences)), setComposerMarkerObjects.of(next.field(composerMarkerObjects)), setInteractionRanges.of(next.field(interactionRanges))], annotations: isolateHistory.of('full'), userEvent: 'input.interaction', filter: false }).state);
  return { updated: insertion.updated };
}
/** Editable wording and its fixed material enter the original draft in one reversible edit. */
export async function composeUiResult(input: UiComposeInput): Promise<UiComposeReceipt> {
  const key = scope(input), editor = composers.get(key);
  let receipt: { updated: boolean };
  const previous = useThreadDraftStore.getState().drafts[key]?.interactionAttachments?.[input.sourceKey];
  try {
    try { receipt = editor ? await editor.composeInteraction(input.sourceKey, input.text, () => input.host === getRuntimeEndpointGeneration() && composers.get(key) === editor,
      { position: input.insertion?.cursor, marker: input.reference ? referenceMarkerObject(input.reference) : undefined, replaceMarkerId: previous }) : insertWithoutEditor(key, input, input.insertion?.cursor); }
    catch (error) {
      scope(input);
      if (editor && composers.get(key) !== editor) receipt = insertWithoutEditor(key, input, input.insertion?.cursor ?? (error instanceof ComposerClosedError ? error.cursor : undefined));
      else throw error;
    }
    scope(input);
    if (input.reference) useThreadDraftStore.getState().patch(key, draft => ({ interactionAttachments: { ...draft.interactionAttachments, [input.sourceKey]: input.reference!.ref } }));
    return { status: 'filled', ...receipt };
  } finally { input.insertion?.dispose(); }
}
/** This is called only by a platform-rendered send button. The iframe bridge has
 * no send command. ThreadConversation accepts through its existing input owner. */
export function sendUiResult(input: UiComposeInput): Promise<UiSendReceipt> {
  const sender = senders.get(scope(input));
  if (!sender) return Promise.reject(new Error('Open the original conversation before sending.'));
  return sender(input).then(receipt => { releaseUiSelection(input.reference, input.host); return receipt; }).finally(() => input.insertion?.dispose());
}
