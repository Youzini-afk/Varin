import { EditorState } from '@codemirror/state';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ComposerClosedError, interactionInsertion, interactionRanges } from '@/components/chat/composer/editor/interactionRanges';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { addContentReference, removeEditorContextAttachment } from '@/lib/agent-editor/attachments';
import { releaseUiSelection } from './selection-lifetime';

export interface UiComposeInput { identity: ThreadIdentity; host: number; sourceKey: string; text: string; reference?: ContentReference }
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
  const store = useThreadDraftStore.getState(), draft = store.drafts[key] ?? EMPTY_THREAD_DRAFT;
  const editor = EditorState.create({ doc: draft.text, extensions: [interactionRanges.init(() => draft.interactions ?? [])] });
  const insertion = interactionInsertion(draft.text, draft.interactions ?? [], input.sourceKey, input.text, cursor);
  const next = editor.update(insertion.spec).state;
  store.patch(key, { text: next.doc.toString(), interactions: next.field(interactionRanges) });
  return { updated: insertion.updated };
}
/** One shared, explicit draft transaction for HTML and declarative controls.
 * Async preparation always targets its original conversation, never the active tab. */
export async function composeUiResult(input: UiComposeInput): Promise<UiComposeReceipt> {
  const key = scope(input), editor = composers.get(key);
  let receipt: { updated: boolean };
  try { receipt = editor ? await editor.composeInteraction(input.sourceKey, input.text, () => input.host === getRuntimeEndpointGeneration() && composers.get(key) === editor) : insertWithoutEditor(key, input); }
  catch (error) {
    scope(input);
    if (editor && composers.get(key) !== editor) receipt = insertWithoutEditor(key, input, error instanceof ComposerClosedError ? error.cursor : undefined);
    else throw error;
  }
  scope(input);
  if (input.reference) {
    const store = useThreadDraftStore.getState(), previous = store.drafts[key]?.interactionAttachments?.[input.sourceKey];
    const attachment = addContentReference(input.identity, input.reference);
    if ('id' in attachment) {
      if (receipt.updated && previous && previous !== attachment.id) removeEditorContextAttachment(previous, threadHostKey(), key);
      store.patch(key, draft => ({ interactionAttachments: { ...draft.interactionAttachments, [input.sourceKey]: attachment.id } }));
    }
  }
  return { status: 'filled', ...receipt };
}
/** This is called only by a platform-rendered send button. The iframe bridge has
 * no send command. ThreadConversation accepts through its existing input owner. */
export function sendUiResult(input: UiComposeInput): Promise<UiSendReceipt> {
  const sender = senders.get(scope(input));
  if (!sender) return Promise.reject(new Error('Open the original conversation before sending.'));
  return sender(input).then(receipt => { releaseUiSelection(input.reference, input.host); return receipt; });
}
