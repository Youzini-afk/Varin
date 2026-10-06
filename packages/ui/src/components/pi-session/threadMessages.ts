import { isAttachedRootPurpose, type ThreadMessagePeer, type ThreadMessageRecord } from '@varin/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';
import { harnessThreadSessionId, harnessThreadTitle } from './harnessThreadPresentation';

export const THREAD_EXCHANGE_OPEN_EVENT = 'varin:thread-exchange-open';
export interface ThreadExchangeLocation { threadId: string; messageId?: string }

export function collectThreadPeers(...groups: Array<readonly HarnessThreadSnapshot[] | undefined>) {
  const peers = new Map<string, HarnessThreadSnapshot>();
  for (const group of groups) for (const entry of group ?? []) {
    if ((peers.get(entry.thread.id)?.thread.eventSeq ?? -1) <= entry.thread.eventSeq) peers.set(entry.thread.id, entry);
  }
  return [...peers.values()];
}

export function groupThreadMessages(messages: readonly ThreadMessageRecord[]) {
  const records = new Map(messages.map(message => [message.id, message]));
  const groups = new Map<string, ThreadMessageRecord[]>();
  for (const message of records.values()) {
    let root = message;
    const visited = new Set([root.id]);
    while (root.replyTo && records.has(root.replyTo) && !visited.has(root.replyTo)) {
      root = records.get(root.replyTo)!;
      visited.add(root.id);
    }
    const group = groups.get(root.id) ?? [];
    group.push(message);
    groups.set(root.id, group);
  }
  return [...groups.entries()].map(([id, entries]) => ({ id,
    messages: entries.sort((left, right) => left.id === id ? -1 : right.id === id ? 1 : left.at.localeCompare(right.at)) })).sort((left, right) =>
    left.messages[0]!.at.localeCompare(right.messages[0]!.at));
}

export type ThreadMessageState = 'failed' | 'replied' | 'waitEnded' | 'queued' | 'recorded' | 'pendingReply' | 'delivered';
export function threadMessageState(message: ThreadMessageRecord, messages: readonly ThreadMessageRecord[]): ThreadMessageState {
  if (message.status === 'failed') return 'failed';
  if (message.status === 'resolved' || messages.some(reply => reply.replyTo === message.id
    && ['held', 'delivered', 'resolved'].includes(reply.status))) return 'replied';
  if (message.wait?.state === 'elapsed' || message.wait?.state === 'interrupted') return 'waitEnded';
  if (message.status === 'pending') return 'queued';
  if (message.status === 'held') return 'recorded';
  return message.kind === 'request' ? 'pendingReply' : 'delivered';
}

export function threadPeerSession(peer: ThreadMessagePeer, entries: readonly HarnessThreadSnapshot[]) {
  if (peer.kind !== 'thread') return peer.id;
  const entry = entries.find(candidate => candidate.thread.id === peer.id);
  return entry ? harnessThreadSessionId(entry) : undefined;
}

export function threadPeerLabel(peer: ThreadMessagePeer, entries: readonly HarnessThreadSnapshot[], labels: { user: string; main: string; thread: string }) {
  if (peer.kind === 'user') return labels.user;
  if (peer.kind === 'session') return labels.main;
  const entry = entries.find(candidate => candidate.thread.id === peer.id);
  return entry ? (isAttachedRootPurpose(entry.thread.purpose) ? labels.main : harnessThreadTitle(entry)) : labels.thread;
}
