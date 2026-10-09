import {
  parseVarinRunActivityDelivery, VARIN_RUN_ACTIVITY_CONTRACT, VARIN_RUN_ACTIVITY_SERVICE_ID,
  VARIN_RUN_ACTIVITY_VERSION, type JsonObject, type JsonValue, type VarinRunActivityDelivery,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';

/** Register an actual durable, queryable activity projection in the broker worker.
 * The reducer must be pure: effects require a separately authorized, attributed command.
 * The projection and deduplication cursor commit in the same existing extension-storage update.
 * A lost acknowledgement can therefore replay safely, without claiming exactly-once effects.
 * The extension must initialize empty schema-0 documents to schema 1 in its normal migrate entry
 * point (see examples/extensions/run-activity); unknown/nonempty old formats must be rejected.
 */
export function provideRunActivityProjection(context: VarinBrokeredHostContext,
  reduce: (projection: Readonly<JsonObject>, delivery: VarinRunActivityDelivery) => JsonObject): void {
  const tails = new Map<string, Promise<unknown>>();
  const open = (subscriptionId: string) => context.storage.open({ scope: 'application', key: `run-activity:${subscriptionId}`, schemaVersion: 1 });
  context.services.provide({ id: VARIN_RUN_ACTIVITY_SERVICE_ID, version: VARIN_RUN_ACTIVITY_VERSION, multiple: true }, {
    inspect: args => {
      if (args.length) throw new Error('Activity inspect takes no arguments');
      return JSON.parse(JSON.stringify(VARIN_RUN_ACTIVITY_CONTRACT)) as JsonValue;
    },
    getSnapshot: async args => {
      if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim()) throw new Error('Activity snapshot requires a subscription ID');
      const snapshot = await (await open(args[0])).refresh();
      if (!snapshot.authoritative) throw new Error('Activity projection storage is unavailable');
      return snapshot.exists ? snapshot.document.data : null;
    },
    observe: (args, call) => {
      if (args.length !== 1) throw new Error('Activity observe requires one delivery');
      const delivery = parseVarinRunActivityDelivery(args[0]);
      const previous = tails.get(delivery.subscriptionId) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        call.signal.throwIfAborted();
        const document = await open(delivery.subscriptionId);
        const snapshot = await document.refresh();
        if (!snapshot.authoritative) throw new Error('Activity projection storage is unavailable');
        const saved = snapshot.document.data;
        if (snapshot.exists && (saved.subscriptionId !== delivery.subscriptionId || !Number.isSafeInteger(saved.cursor)
          || Number(saved.cursor) < 1 || !saved.projection || typeof saved.projection !== 'object' || Array.isArray(saved.projection))) {
          throw new Error('Activity projection checkpoint is invalid');
        }
        if (!snapshot.exists || Number(saved.cursor) < delivery.fact.cursor) {
          const input = structuredClone((saved.projection ?? {}) as JsonObject);
          const projection = reduce(input, delivery);
          call.signal.throwIfAborted();
          await document.update({ subscriptionId: delivery.subscriptionId, cursor: delivery.fact.cursor, projection }, snapshot.document.revision);
        }
        return { subscriptionId: delivery.subscriptionId, deliveryId: delivery.deliveryId, cursor: delivery.fact.cursor };
      });
      tails.set(delivery.subscriptionId, pending);
      void pending.finally(() => { if (tails.get(delivery.subscriptionId) === pending) tails.delete(delivery.subscriptionId); }).catch(() => {});
      return pending;
    },
  });
}
