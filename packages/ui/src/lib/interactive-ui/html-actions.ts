import { createInteractiveUiHttpAPI, type ContentReference, type UiObservation, type UiSelection } from '@varin/application-client';
import type { UiComposeInput, UiComposeInsertion } from './compose';
import { uiDiscussionText } from './discussion';
import type { UiSession } from './sessions';

export function uiSelectionReference(session: UiSession, selection: UiSelection): ContentReference {
  return { ref: selection.ref, title: selection.title, text: selection.text, image: selection.image,
    source: { kind: 'ui', thread: session.identity, itemId: session.sourceEntryId, snapshotRef: selection.snapshotRef,
      viewRef: selection.viewRef, revisionRef: selection.source.ref, previewCallId: selection.source.preview?.callId, region: selection.region } };
}
export async function prepareHtmlResult(session: UiSession, observation: UiObservation, text: string, includeContext = false, insertion?: UiComposeInsertion): Promise<UiComposeInput> {
  // The snapshot contains the source and selected discussion data. It is not
  // concatenated into the user's editable text or relabelled as instructions.
  const captured = { ...observation, ...(includeContext ? {} : { context: undefined }) };
  const selection = await createInteractiveUiHttpAPI(session.host).select(session.identity, captured, { text: includeContext ? uiDiscussionText(captured) || text : text });
  return { identity: session.identity, host: session.host, sourceKey: session.key, text, insertion, reference: uiSelectionReference(session, selection) };
}
