import type { ExternalItem } from '@varin/application-client';
import { record, text, type RecordValue } from './transport.js';

type Item = Omit<ExternalItem, 'turnId'>;
interface Block {
  type: string;
  item: Item;
  finalized: boolean;
  json: string;
}
interface Message {
  blocks: Map<number, Block>;
  nextIndex: number;
}

/** SDK 0.3 emits one completed assistant frame per block, not a cumulative
 * content array. Stream indices belong to a message AND its native parent.
 * See SDKAssistantMessage / SDKPartialAssistantMessage in the pinned SDK. */
export class ClaudeContent {
  private readonly messages = new Map<string, Message>();
  private readonly current = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly tools = new Map<string, Item>();

  constructor(private readonly publish: (item: Item) => void) {}

  receive(frame: RecordValue) {
    const scope = JSON.stringify([text(frame.session_id), text(frame.parent_tool_use_id)]);
    if (frame.type === 'stream_event') {
      const event = record(frame.event);
      if (event.type === 'message_start') {
        const id = text(record(event.message).id);
        if (id) this.current.set(scope, id);
        return;
      }
      const messageId = this.current.get(scope);
      if (!messageId || !Number.isInteger(event.index)) return;
      const message = this.message(scope, messageId);
      const index = Number(event.index);
      if (event.type === 'content_block_start') {
        const block = this.block(scope, messageId, index, record(event.content_block));
        if (!block) return;
        message.blocks.set(index, block);
        message.nextIndex = Math.max(message.nextIndex, index + 1);
        this.emit(scope, block);
      }
      const block = message.blocks.get(index);
      if (!block || block.finalized) return;
      if (event.type === 'content_block_delta') {
        const delta = record(event.delta);
        if (block.item.tool && delta.type === 'input_json_delta') {
          block.json += text(delta.partial_json);
          let input: unknown = block.json;
          try {
            input = JSON.parse(block.json);
          } catch {
            /* A partial argument is not JSON yet. */
          }
          block.item = { ...block.item, tool: { ...block.item.tool, input } };
        } else if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          block.item = {
            ...block.item,
            text: block.item.text + text(delta.text ?? delta.thinking),
          };
        } else return;
        this.emit(scope, block);
      } else if (event.type === 'content_block_stop' && !block.item.tool) {
        block.item = { ...block.item, complete: true };
        this.emit(scope, block);
      }
      return;
    }
    if (frame.type === 'assistant') {
      const raw = record(frame.message),
        messageId = text(raw.id);
      if (!messageId) return;
      const uuid = text(frame.uuid);
      const delivery = uuid && JSON.stringify([scope, uuid]);
      if (delivery && this.completed.has(delivery)) return;
      if (delivery) this.completed.add(delivery);
      const message = this.message(scope, messageId);
      for (const value of Array.isArray(raw.content) ? raw.content : []) {
        const rawBlock = record(value),
          type = text(rawBlock.type);
        // Completed per-block frames have index 0 in their own array. Match the
        // oldest unfinished block of this type in the corresponding stream.
        const match = [...message.blocks.entries()].find(
          ([, block]) =>
            !block.finalized &&
            block.type === type &&
            (type !== 'tool_use' || block.item.id === this.toolId(scope, text(rawBlock.id))),
        );
        const index = match?.[0] ?? message.nextIndex++;
        const block = this.block(scope, messageId, index, rawBlock);
        if (!block) continue;
        block.finalized = true;
        if (!block.item.tool) block.item.complete = true;
        message.blocks.set(index, block);
        this.emit(scope, block);
        if (
          type === 'tool_use' &&
          rawBlock.name === 'TodoWrite' &&
          Array.isArray(record(rawBlock.input).todos)
        ) {
          this.publish({
            id: `plan:${scope}`,
            kind: 'plan',
            complete: true,
            text: (record(rawBlock.input).todos as unknown[])
              .map((value) => {
                const step = record(value);
                return `- [${step.status === 'completed' ? 'x' : step.status === 'in_progress' ? '/' : ' '}] ${text(step.content)}`;
              })
              .join('\n'),
          });
        }
      }
      return;
    }
    if (frame.type === 'user') {
      for (const value of Array.isArray(record(frame.message).content)
        ? (record(frame.message).content as unknown[])
        : []) {
        const block = record(value),
          id = this.toolId(scope, text(block.tool_use_id)),
          previous = this.tools.get(id);
        if (block.type !== 'tool_result' || !previous?.tool) continue;
        const item: Item = {
          ...previous,
          tool: {
            ...previous.tool,
            output: block.content,
            status: block.is_error ? 'failed' : 'completed',
          },
        };
        this.tools.set(id, item);
        this.publish(item);
      }
    }
  }

  private message(scope: string, id: string): Message {
    const key = JSON.stringify([scope, id]);
    let value = this.messages.get(key);
    if (!value) {
      value = { blocks: new Map(), nextIndex: 0 };
      this.messages.set(key, value);
    }
    return value;
  }
  private toolId(scope: string, id: string) {
    return `tool:${scope}:${id}`;
  }
  private block(
    scope: string,
    messageId: string,
    index: number,
    raw: RecordValue,
  ): Block | undefined {
    const type = text(raw.type);
    if (!['text', 'thinking', 'tool_use'].includes(type)) return undefined;
    if (type === 'tool_use' && !text(raw.id)) return undefined;
    return {
      type,
      finalized: false,
      json: '',
      item:
        type === 'tool_use'
          ? {
              id: this.toolId(scope, text(raw.id)),
              kind: 'tool',
              text: '',
              tool: { name: text(raw.name), input: raw.input, status: 'running' },
            }
          : {
              id: `block:${JSON.stringify([scope, messageId, index])}`,
              kind: type === 'thinking' ? 'reasoning' : 'assistant',
              text: text(raw.text ?? raw.thinking),
            },
    };
  }
  private emit(_scope: string, block: Block) {
    if (block.item.tool) this.tools.set(block.item.id, block.item);
    this.publish(block.item);
  }
}
