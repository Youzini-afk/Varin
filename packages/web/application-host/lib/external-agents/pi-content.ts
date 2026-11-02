import type { ExternalItem, ExternalTurn } from '@varin/application-client';
import { record, text, type RecordValue } from './transport.js';
type Item = Omit<ExternalItem, 'turnId'>;

/** Pi >=1.5 wire updates carry deltas, not SDK cumulative message snapshots. */
export class PiContent {
  private number = 0;
  private current = '';
  private blocks = new Map<number, { type: string; text: string }>();
  private readonly tools = new Map<string, Item>();
  private readonly visible = new Set<string>();
  private readonly usages = new Map<string, RecordValue>();
  lastAssistant?: RecordValue;
  constructor(
    private readonly prefix: string,
    private readonly publish: (item: Item) => void,
    private readonly usage: (usage: NonNullable<ExternalTurn['usage']>) => void,
  ) {}

  receive(event: RecordValue) {
    const message = record(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') {
      this.current = `${this.prefix}:assistant:${++this.number}`;
      this.blocks = new Map();
      this.snapshot(message, false);
    } else if (event.type === 'message_update' && this.current) {
      const delta = record(event.assistantMessageEvent),
        type = text(delta.type),
        index = Number(delta.contentIndex);
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        /^(text|thinking)_(start|delta|end)$/.test(type)
      ) {
        const kind = type.startsWith('text_') ? 'text' : 'thinking';
        const block = this.blocks.get(index) ?? { type: kind, text: '' };
        if (block.type !== kind) return;
        block.text = type.endsWith('_end') ? text(delta.content) : block.text + text(delta.delta);
        this.blocks.set(index, block);
        this.render(false);
      }
      this.recordUsage(record(event.usage));
    } else if (event.type === 'message_end' && message.role === 'assistant' && this.current) {
      this.snapshot(message, true);
      this.lastAssistant = message;
    } else if (event.type === 'tool_execution_start') {
      const nativeId = text(event.toolCallId);
      if (!nativeId) return;
      const id = `${this.prefix}:tool:${nativeId}`;
      const item: Item = {
        id,
        kind: 'tool',
        text: '',
        tool: { name: text(event.toolName), input: event.args, status: 'running' },
      };
      this.tools.set(nativeId, item);
      this.publish(item);
    } else if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const id = text(event.toolCallId),
        previous = this.tools.get(id);
      if (!previous?.tool) return;
      const item: Item = {
        ...previous,
        tool: {
          ...previous.tool,
          output: event.result ?? event.partialResult,
          status:
            event.type === 'tool_execution_update'
              ? 'running'
              : event.isError
                ? 'failed'
                : 'completed',
        },
      };
      this.tools.set(id, item);
      this.publish(item);
    } else if (event.type === 'agent_end') {
      const messages = (Array.isArray(event.messages) ? event.messages : []).map(record);
      const last = messages.findLast((value) => value.role === 'assistant');
      if (last) this.lastAssistant = last;
    }
  }
  private snapshot(message: RecordValue, complete: boolean) {
    this.blocks.clear();
    for (const [index, value] of (Array.isArray(message.content)
      ? message.content
      : []
    ).entries()) {
      const block = record(value),
        type = text(block.type);
      if (type === 'text' || type === 'thinking')
        this.blocks.set(index, { type, text: text(block.text ?? block.thinking) });
    }
    this.render(complete);
    this.recordUsage(record(message.usage));
  }
  private render(complete: boolean) {
    for (const type of ['text', 'thinking']) {
      const content = [...this.blocks.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, block]) => block.type === type)
        .map(([, block]) => block.text)
        .join('\n');
      const id = `${this.current}:${type}`;
      if (!content && !this.visible.has(id)) continue;
      this.visible.add(id);
      // Also publish an empty authoritative final to clear a removed partial.
      this.publish({
        id,
        kind: type === 'text' ? 'assistant' : 'reasoning',
        text: content,
        complete,
      });
    }
  }
  private recordUsage(value: RecordValue) {
    if (!this.current || !Object.keys(value).length) return;
    this.usages.set(this.current, value);
    const sum = (field: string) => {
      const values = [...this.usages.values()]
        .map((usage) => usage[field])
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    this.usage({
      input: sum('input'),
      output: sum('output'),
      cachedInput: sum('cacheRead'),
      cacheCreated: sum('cacheWrite'),
      inputIncludesCache: false,
      scope: 'turn',
    });
  }
}
