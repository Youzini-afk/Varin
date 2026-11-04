import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration } from '@varin/application-client';
import { uiSession, updateUiSession, type UiSession } from './sessions';
/** Resolve on explicit intent only. The historical view is never retargeted. */
export async function latestUiRevision(original: UiSession): Promise<UiSession | undefined> {
  const ref = original.display?.source.ref;
  if (!ref) return undefined;
  const source = await createInteractiveUiHttpAPI(original.host).source(original.identity, original.source?.workRef ?? ref.replace(/@\d+$/, ''));
  if (original.host !== getRuntimeEndpointGeneration()) throw new Error('Host changed; reopen this content.');
  if (source.ref === ref) return undefined;
  const session = uiSession(`${original.key}:revision:${source.ref}`, original.identity, original.host);
  session.source = source;
  session.sourceEntryId = original.sourceEntryId;
  updateUiSession(session, { source: { ref: source.ref }, content: source.content, files: source.contents, assets: source.assets,
    title: source.title, entry: source.entry, committed: true, status: '' });
  return session;
}
