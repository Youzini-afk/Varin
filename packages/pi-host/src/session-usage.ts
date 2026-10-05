import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { SessionModelUsage } from '@varin/protocol';

/** Match native session billing totals without attributing unidentified calls to the current model. */
export function sessionUsageByModel(entries: readonly SessionEntry[]): SessionModelUsage[] {
  const models = new Map<string, SessionModelUsage>();
  const add = (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, provider: string | null, model: string | null) => {
    const key = JSON.stringify([provider, model]);
    let row = models.get(key);
    if (!row) {
      row = { provider, model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      models.set(key, row);
    }
    row.tokens.input += usage.input;
    row.tokens.output += usage.output;
    row.tokens.cacheRead += usage.cacheRead;
    row.tokens.cacheWrite += usage.cacheWrite;
    row.tokens.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  };
  for (const entry of entries) {
    if (entry.type === 'usage') {
      add(entry.usage, entry.provider, entry.model);
    } else if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
      add(entry.usage, null, null);
    } else if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'assistant') add(message.usage, message.provider, message.model);
      else if (message.role === 'toolResult' && message.usage) add(message.usage, null, null);
    }
  }
  return [...models.values()].filter((row) => row.tokens.total > 0);
}
