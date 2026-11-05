import type { ExternalTurn } from '@varin/application-client';

type Usage = NonNullable<ExternalTurn['usage']>;
const fields = ['input', 'output', 'cachedInput', 'cacheCreated'] as const;
const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function clean(usage: Usage): Usage {
  return {
    ...Object.fromEntries(fields.flatMap(key => valid(usage[key]) ? [[key, usage[key]]] : [])),
    ...(typeof usage.inputIncludesCache === 'boolean' ? { inputIncludesCache: usage.inputIncludesCache } : {}),
    scope: usage.scope,
  };
}

/** Receipts are complete session history, independent of the visible item page.
 * Conversation snapshots replace earlier totals; last-request counters never add.
 */
export function externalUsageSummary(turns: readonly ExternalTurn[]) {
  let total: Usage | undefined, lastRequest: Usage | undefined;
  let complete = true;
  const unique = new Map(turns.map(turn => [turn.id, turn]));
  for (const turn of unique.values()) {
    const usage = turn.usage && clean(turn.usage);
    if (usage?.scope === 'conversation') {
      total = { ...usage };
      complete = true;
      lastRequest = undefined;
    } else if (usage?.scope === 'turn') {
      if (!total) total = { ...usage };
      else {
        const sameInputBasis = total.inputIncludesCache === usage.inputIncludesCache;
        total = {
          ...Object.fromEntries(fields.flatMap(key =>
            valid(total![key]) && valid(usage[key]) && valid(total![key]! + usage[key]!) && (key !== 'input' || sameInputBasis)
              ? [[key, total![key]! + usage[key]!]] : [])),
          ...(sameInputBasis ? { inputIncludesCache: total.inputIncludesCache } : {}),
          scope: 'conversation',
        };
      }
    } else if (usage?.scope === 'last_request') {
      lastRequest = usage;
      complete = false;
    } else if (!['queued', 'preparing'].includes(turn.status)) complete = false;
  }
  return {
    total: total && fields.some(key => valid(total![key])) ? total : undefined,
    lastRequest: lastRequest && fields.some(key => valid(lastRequest![key])) ? lastRequest : undefined,
    complete,
  };
}

export function externalCacheRate(usage: Usage): number | undefined {
  if (!valid(usage.input) || !valid(usage.cachedInput) ||
      typeof usage.inputIncludesCache !== 'boolean') return undefined;
  if (!usage.inputIncludesCache && !valid(usage.cacheCreated)) return undefined;
  const denominator = usage.input + (usage.inputIncludesCache ? 0 : usage.cachedInput + usage.cacheCreated!);
  return Number.isSafeInteger(denominator) && denominator > 0 && usage.cachedInput <= denominator
    ? usage.cachedInput / denominator * 100 : undefined;
}
