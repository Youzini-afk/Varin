import { defineHostExtension, provideRunActivityProjection } from '@varin/extension-sdk';

export default defineHostExtension({
  // Fresh extension documents begin at schema 0. Initialize only an empty document; never
  // silently discard an existing projection or pretend to upgrade an unknown format.
  migrate({ data, fromSchemaVersion, toSchemaVersion }) {
    if (fromSchemaVersion !== 0 || toSchemaVersion !== 1 || Object.keys(data).length !== 0) {
      throw new Error('Unsupported activity projection storage format');
    }
    return {};
  },
  activate(context) {
    provideRunActivityProjection(context, (projection, { threadId, fact }) => ({
      ...projection,
      [fact.subject]: { threadId, runId: fact.subject, cursor: fact.cursor, revision: fact.revision,
        event: fact.kind, state: fact.data.state ?? (fact.kind === 'run.accepted' ? 'accepted' : 'cancel_requested') },
    }));
  },
});
