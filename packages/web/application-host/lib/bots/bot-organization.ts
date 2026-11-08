import { randomUUID } from 'node:crypto';
import { applyBotOrganizationChange, emptyBotOrganization, parseBotOrganization, type BotOrganization, type BotOrganizationAPI } from '@varin/application-client';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
import { HarnessServiceError } from '../harness/service-error.js';

export class BotOrganizationConflict extends Error {
  constructor() { super('Bot groups changed. Reload before trying again.'); }
}

export function createBotOrganization(options: {
  client(): Promise<KernelScopedClient>;
  workspaceId: string;
  botIds(): Promise<string[]>;
  changed?: (() => void) | undefined;
}): BotOrganizationAPI {
  const recordId = 'bot.organization:sidebar';
  let pending = Promise.resolve<unknown>(undefined);
  const read = async (): Promise<BotOrganization> => {
    const stored = await (await options.client()).getRecord(options.workspaceId, recordId);
    if (!stored) return emptyBotOrganization();
    if (stored.recordType !== 'bot.organization') throw new Error('Unexpected Bot organization record');
    return parseBotOrganization({ ...JSON.parse(stored.payloadJson), revision: stored.recordRevision });
  };
  return {
    read,
    update(input) {
      const task = pending.catch(() => undefined).then(async () => {
        if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new HarnessServiceError('invalid-params', 'A Bot organization revision is required');
        const current = await read();
        if (current.revision !== input.expectedRevision) throw new BotOrganizationConflict();
        const botIds = await options.botIds();
        let next: BotOrganization;
        try { next = applyBotOrganizationChange(current, input.change, botIds); }
        catch (error) { throw new HarnessServiceError('invalid-params', error instanceof Error ? error.message : 'Invalid Bot organization change'); }
        const result = await (await options.client()).putRecord({
          operationId: `bot.organization:${randomUUID()}`, workspaceId: options.workspaceId, recordId, recordType: 'bot.organization',
          state: 'active', payloadJson: JSON.stringify({ id: 'sidebar', groups: next.groups, ungrouped: next.ungrouped }), ownerIds: [], references: [],
          ...(current.revision ? { expectedRecordRevision: current.revision } : {}),
        }).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'record-revision-conflict') throw new BotOrganizationConflict();
          throw error;
        });
        options.changed?.();
        return { ...next, revision: result.recordRevision };
      });
      pending = task;
      return task;
    },
  };
}
