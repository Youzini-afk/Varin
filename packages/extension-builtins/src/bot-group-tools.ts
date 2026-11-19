import type { VarinExtensionServiceProvision } from '@varin/extension-contract';

export const BOT_GROUP_CAPABILITY = 'bot-group-chat';
export const BOT_GROUP_TOOLS: readonly VarinExtensionServiceProvision[] = [
  { id: 'varin.bot-group.read', version: 1, tool: { name: 'bot_group_read', operation: 'read', completion: 'result',
    description: 'List your Bot group chats or read a group by name or reference. Query searches posts and filenames. Use post references for replies or a file reference to bring a shared attachment into your current conversation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { group: { type: 'string' }, query: { type: 'string' }, before: { type: 'string' }, file: { type: 'string' } } },
    outputSchema: { type: 'object' } } },
  { id: 'varin.bot-group.write', version: 1, tool: { name: 'bot_group_write', operation: 'effect', completion: 'result',
    description: 'Post a message to a Bot group you belong to, or change your own listening setting. Listening gives you user messages without a named recipient. Address other members by name to give them work, or use inform to deliver without starting a turn. You can share a delegated task from your current conversation by its agent reference or exact name.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['group'], properties: {
      group: { type: 'string' }, listening: { type: 'boolean' }, text: { type: 'string' }, replyTo: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } }, inform: { type: 'boolean' }, task: { type: 'string' },
      files: { type: 'array', description: 'Attachment references already available in your current conversation.', items: { type: 'string' } },
    }, oneOf: [{ required: ['listening'] }, { required: ['text'] }] }, outputSchema: { type: 'object' } } },
];
