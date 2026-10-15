import { getToolSummary } from '@/components/chat/message/parts/toolSummary';
import type { ChatAssistantMessage, ChatSessionMessageEntry, ChatUserMessage, ChatSessionEntry } from './types';
export interface SessionTreeNode { entry: ChatSessionEntry; children: SessionTreeNode[]; label?: string; labelTimestamp?: string }
export interface SessionTreeResult { tree: SessionTreeNode[]; leafId: string | null }

export interface ChatSessionTreeItem {
  active: boolean;
  branchDepth: number;
  current: boolean;
  entry: ChatSessionMessageEntry;
  label?: string;
  labelTimestamp?: string;
  text: string;
}

const isNavigableMessage = (
  entry: SessionTreeNode['entry'],
): entry is ChatSessionMessageEntry & { message: ChatAssistantMessage | ChatUserMessage } => (
  entry.type === 'message'
  && (entry.message.role === 'user' || entry.message.role === 'assistant' && entry.message.content.some(part => part.type === 'toolCall' || (part.type === 'text' ? part.text.trim() : part.thinking.trim())))
);

const messageText = (entry: ChatSessionMessageEntry): string => {
  const { message } = entry;
  if (message.role === 'user') {
    return (typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')).trim();
  }
  if (message.role === 'assistant') {
    return message.content
      .map(part => part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : getToolSummary({ toolName: part.name, arguments: part.arguments }).text || part.name)
      .join('\n')
      .trim();
  }
  return '';
};

/**
 * Project immutable message ancestry into message rows. Indentation tracks
 * branch splits, not total message ancestry, so a long linear conversation does
 * not drift horizontally across the dialog.
 */
export const projectChatSessionTree = (result: SessionTreeResult): ChatSessionTreeItem[] => {
  const nodes = new Map<string, SessionTreeNode>();
  const collect = (items: readonly SessionTreeNode[]) => {
    for (const node of items) {
      nodes.set(node.entry.id, node);
      collect(node.children);
    }
  };
  collect(result.tree);

  const activePath = new Set<string>();
  let cursor = result.leafId;
  while (cursor) {
    if (activePath.has(cursor)) break;
    activePath.add(cursor);
    cursor = nodes.get(cursor)?.entry.parentId ?? null;
  }

  let currentMessageId: string | null = null;
  cursor = result.leafId;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) break;
    if (isNavigableMessage(node.entry)) {
      currentMessageId = node.entry.id;
      break;
    }
    cursor = node.entry.parentId;
  }

  const projected: ChatSessionTreeItem[] = [];
  const visit = (node: SessionTreeNode, branchDepth: number) => {
    if (isNavigableMessage(node.entry)) {
      projected.push({
        active: activePath.has(node.entry.id),
        branchDepth,
        current: node.entry.id === currentMessageId,
        entry: node.entry,
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: node.labelTimestamp }),
        text: messageText(node.entry),
      });
    }

    const activeChild = node.children.find((child) => activePath.has(child.entry.id));
    const primaryChild = activeChild ?? node.children[0];
    for (const child of node.children) {
      visit(child, child === primaryChild ? branchDepth : branchDepth + 1);
    }
  };
  for (const root of result.tree) visit(root, 0);
  return projected;
};
