import { createHash } from 'node:crypto';
import { BOT_GROUP_CAPABILITY } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { runToolDomainCall } from '../kernel/tool-invocation.js';
import type { BotGroupChats } from './bot-group-chat.js';

export function createBotGroupToolOwner(groups: BotGroupChats, runtime: Pick<AgentRuntimeClient, 'thread' | 'run' | 'threadView'>): HostCapabilityHandler {
  return (method, input, context) => {
    if (method !== 'read' && method !== 'write') throw new Error('Unknown group chat operation');
    const args = input as { group?: string; text?: string; listening?: boolean; replyTo?: string; query?: string; before?: string; to?: string[]; inform?: boolean; task?: string; file?: string; files?: string[] };
    return runToolDomainCall(context, { operation: method === 'read' ? 'read' : 'effect', domain: BOT_GROUP_CAPABILITY,
      toolName: `bot_group_${method}`, arguments: input }, async authority => {
      const thread = await runtime.thread(authority.threadId, context.signal);
      if (!thread.bot_id || thread.parent_thread_id) throw new Error('Group chat is available to Bot conversations');
      const botId = thread.bot_id;
      const principal = authority.principalId ?? null;
      const rooms = await groups.botGroups(principal, botId);
      const ref = (value: string) => value.slice(0, 8);
      const postRef = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
      const matches = rooms.filter(room => room.name === args.group || ref(room.id) === args.group);
      const room = matches.length === 1 ? matches[0] : undefined;
      let result: unknown;
      if (!args.group && method === 'read') {
        result = { groups: rooms.map(value => ({ name: value.name, ref: ref(value.id) })) };
      } else if (!room) {
        throw new Error('Choose a group by its unique name or reference from bot_group_read');
      } else if (method === 'read' && args.file) {
        const run = await runtime.run(authority.runId, context.signal);
        const attachment = await groups.botFile(principal, room.id, botId, { runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id }, args.file, context.signal);
        result = { group: room.name, attachment };
      } else if (method === 'read') {
        const before = args.before ? room.posts.find(post => postRef(post.id) === args.before)?.id : undefined;
        if (args.before && !before) throw new Error('Use a history cursor returned by bot_group_read');
        const page = await groups.page(principal, room.id, before, args.query, botId);
        result = { group: room.name, members: page.members.map(member => ({ name: member.name, ref: ref(member.membership), listening: member.listening })),
          posts: page.posts.filter(post => post.author.kind !== 'system').map(post => ({ post: postRef(post.id), at: new Date(post.at).toISOString(),
            author: post.author.kind === 'bot' ? post.author.name : 'User', text: post.text, ...(post.quoteId ? { replyTo: postRef(post.quoteId) } : {}),
            ...(post.files?.length ? { files: post.files.map(file => ({ ref: ref(file.id), name: file.filename })) } : {}) })),
          before: page.before ? postRef(page.before) : null };
      } else if (typeof args.listening === 'boolean') {
        await groups.change(principal, room.id, { kind: 'listen', botId, enabled: args.listening }, 'bot');
        result = { group: room.name, listening: args.listening };
      } else {
        if (typeof args.text !== 'string') throw new Error('A group message is required');
        const run = await runtime.run(authority.runId, context.signal);
        const addressed = (args.to ?? []).map(name => {
          const members = room.members.filter(member => member.name === name || ref(member.membership) === name);
          if (members.length !== 1) throw new Error('Use an exact member name or reference from bot_group_read');
          return members[0]!.botId;
        });
        let work;
        if (args.task) {
          const snapshot = await runtime.threadView({ threadId: run.thread_id, branchId: run.branch_id, historyLimit: 1 }, context.signal);
          const children = (snapshot.childExecutions ?? []).filter(child => child.name === args.task || child.agent_id === args.task || child.execution_id === args.task);
          const latest = new Map(children.map(child => [child.child_thread_id, child]));
          const child = latest.size === 1 ? [...latest.values()][0] : undefined;
          if (!child) throw new Error('Choose one of the tasks delegated from this conversation');
          work = { title: child.name ?? args.task, identity: { runtime: 'agent' as const, threadId: child.child_thread_id, branchId: child.child_branch_id } };
        }
        const quote = args.replyTo ? room.posts.find(post => postRef(post.id) === args.replyTo)?.id : undefined;
        if (args.replyTo && !quote) throw new Error('Use a post reference returned by bot_group_read');
        await groups.botPost(principal, room.id, botId, { threadId: run.thread_id, branchId: run.branch_id, operationId: authority.operationId }, args.text, quote, addressed, args.inform, work, args.files, context.signal);
        result = { group: room.name, posted: true };
      }
      return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: method === 'write' ? 'confirmed' : 'none',
        content: { data: parseVarinToolJson(JSON.parse(JSON.stringify(result))), parts: [] } } };
    });
  };
}
