import type { JsonValue } from '@varin/protocol';
import type { ChatToolResultMessage, ChatUserContent } from './types';
type JsonObject = Record<string, JsonValue>;
const isObject = (value: JsonValue | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stringValue = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' ? value : undefined
);

const numberValue = (value: JsonValue | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

export interface ToolCallPresentation {
  id: string;
  name: string;
  status: 'ok' | 'error' | 'unfinished' | 'running' | 'cancelled';
  model?: string;
  durationMs?: number;
  error?: string;
  cost?: number;
}

/** Native nested tool receipts and codemode's model rows describe different calls. */
export function projectToolCalls(result: Pick<ChatToolResultMessage, 'toolName' | 'nestedCalls' | 'details'>, live = false): { calls: ToolCallPresentation[]; complete: boolean } | undefined {
  const native = new Map<string, ToolCallPresentation>(result.nestedCalls?.calls.map(call => [call.id, { ...call }]));
  const calls = new Map<string, ToolCallPresentation>();
  // Progress events contain the native ToolResult envelope; final messages carry its details directly.
  const details = isObject(result.details) && !Array.isArray(result.details.calls) && isObject(result.details.details)
    ? result.details.details : result.details;
  if (result.toolName === 'codemode' && isObject(details) && Array.isArray(details.calls)) {
    for (const value of details.calls) {
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
        || typeof value.status !== 'string' || !['running', 'ok', 'error', 'cancelled'].includes(value.status)) continue;
      const previous = native.get(value.id);
      if (previous && previous.name !== value.name) continue;
      const duration = numberValue(value.durationMs);
      const cost = numberValue(value.cost);
      const model = (value.name === 'models.classify' || value.name === 'models.generateImages')
        ? stringValue(value.args) : undefined;
      calls.set(value.id, {
        id: value.id, name: value.name,
        status: previous?.status ?? (value.status === 'running' && !live
          ? 'unfinished' : value.status as ToolCallPresentation['status']),
        ...(model === undefined ? {} : { model }),
        ...(cost === undefined || cost < 0 ? {} : { cost }),
        ...(duration === undefined || duration < 0 ? {} : { durationMs: duration }),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...previous,
      });
    }
  }
  for (const [id, call] of native) if (!calls.has(id)) calls.set(id, call);
  if (!calls.size && !result.nestedCalls) return undefined;
  const rows = [...calls.values()];
  return { calls: rows, complete: (result.nestedCalls?.complete ?? true)
    && rows.every(call => call.status !== 'running' && call.status !== 'unfinished') };
}

export const chatContentText = (content: string | ChatUserContent[]): string => (
  typeof content === 'string'
    ? content
    : content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
);
