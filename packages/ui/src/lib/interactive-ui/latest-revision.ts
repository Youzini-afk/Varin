import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, migrateConversationUiState } from '@varin/application-client';
import { uiSession, updateUiSession, type UiSession } from './sessions';
/** Resolve on explicit intent only. The historical view is never retargeted. */
export async function latestUiRevision(original: UiSession): Promise<UiSession | undefined> {
  const ref = original.display?.source.ref;
  if (!ref) return undefined;
  const source = await createInteractiveUiHttpAPI(original.host).source(original.identity, original.source?.workRef ?? ref.replace(/@\d+$/, ''));
  if (original.host !== getRuntimeEndpointGeneration()) throw new Error('Host changed; reopen this content.');
  if (source.ref === ref) return undefined;
  await original.flushState?.();
  if (original.host !== getRuntimeEndpointGeneration()) throw new Error('Host changed; reopen this content.');
  const session = uiSession(`${original.key}:revision:${source.ref}`, original.identity, original.host);
  if (!session.state && !session.initialState && original.state) {
    const state = structuredClone(original.state);
    if (original.display?.content && source.content) {
      const values = state.data && typeof state.data === 'object' && !Array.isArray(state.data) ? state.data : {};
      const migrated = migrateConversationUiState(original.display.content, source.content, values);
      state.data = migrated.values;
      state.controls = { ...state.controls, __varinDefinition: source.content as unknown as import('@varin/protocol').JsonValue, __varinResetKeys: migrated.resetKeys };
    }
    session.initialState = state;
  }
  session.source = source;
  session.sourceEntryId = original.sourceEntryId;
  updateUiSession(session, { source: { ref: source.ref }, content: source.content, files: source.contents, assets: source.assets,
    title: source.title, entry: source.entry, committed: true, status: '' });
  return session;
}
