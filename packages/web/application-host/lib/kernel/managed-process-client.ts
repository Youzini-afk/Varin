import { randomUUID } from 'node:crypto';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceProcessAddress } from '../harness/managed-remote-types.js';
import type { ProcessProjectionClient } from './process-service.js';

/** The coordinator has a view, never a local process or a replacement execution grant. */
export function createManagedProcessClient(client: ManagedSourceClient, address: ManagedSourceProcessAddress,
  source: { workspaceId: string; rootId: string }): ProcessProjectionClient {
  const requireAddress = (input: { processId: string; workspaceId: string; rootId?: string }) => {
    if (input.processId !== address.processId || input.workspaceId !== source.workspaceId || input.rootId !== source.rootId)
      throw new Error('Original managed process projection address changed');
  };
  return {
    processSubscribe(input, observer) {
      requireAddress(input);
      return client.processSubscribe({ ...address, subscriptionId: randomUUID(), cursor: input.cursor ?? 0 }, observer);
    },
    processWrite(input) {
      requireAddress(input);
      return client.processWrite({ ...address, operationId: input.operationId, bytesBase64: input.bytesBase64,
        ...(input.eof === undefined ? {} : { eof: input.eof }) });
    },
    processResize(input) {
      requireAddress(input);
      return client.processResize({ ...address, operationId: input.operationId, cols: input.cols, rows: input.rows });
    },
    async processKill() { throw new Error('Stop the original Catalog process operation'); },
    async processRelease() { throw new Error('Original managed process output belongs to its accepted operation'); },
  };
}
