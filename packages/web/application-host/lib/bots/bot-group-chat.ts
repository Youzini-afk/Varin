import { createHash, randomUUID } from 'node:crypto';
import type { BotGroupMember, BotGroupPost, BotGroupSummary, GroupChange, GroupChatFile, GroupDelivery, GroupPostInput, ThreadIdentity, ThreadModel } from '@varin/application-client';
import { attachmentMimeType } from '@varin/protocol';
import type { BotService } from './bot-service.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
import { ThreadPreAdmissionError, type ThreadAdapter } from '../kernel/thread-adapter.js';
import { validateAttachmentFilename, type ThreadAttachmentOwner } from '../kernel/thread-attachments.js';
import { threadEventHub } from '../kernel/event-hub.js';
import { withRequestPrincipal } from '../kernel/request-principal.js';

export const GROUP_THREAD_PREFIX = 'thread:bot-group:';
const recordType = 'bot.group-chat';
const running = (delivery: GroupDelivery) => delivery.state === 'queued' || delivery.state === 'running';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const missing = () => Object.assign(new Error('Group chat not found'), { status: 404 });
const terminal = new Set(['completed', 'failed', 'cancelled']);

type Delivery = GroupDelivery & { expectedHead?: string | null; model?: ThreadModel; messageId?: string; wakeRequested?: boolean };
type GroupOrigin = { threadId: string; branchId: string; operationId: string };
type Post = Omit<BotGroupPost, 'delivery'> & { delivery: Delivery[]; origin?: GroupOrigin };
type StoredFile = { info: GroupChatFile; hash: string; ownerId: string };
type Room = { id: string; name: string; principal: string | null; members: BotGroupMember[]; posts: Post[]; updatedAt: number; deleted?: boolean; publishedBackgroundRuns?: string[]; files?: StoredFile[] };
type Stored = { room: Room; revision: number };
type Options = {
  client(): Promise<KernelScopedClient>;
  workspaceId: string;
  bots: Pick<BotService, 'get' | 'canExecute' | 'wake'>;
  runtime: AgentRuntimeClient;
  threads: ThreadAdapter;
  attachments: Pick<ThreadAttachmentOwner, 'upload' | 'readChunk'>;
  model(bot: NonNullable<Awaited<ReturnType<BotService['get']>>>): Promise<ThreadModel | null>;
  pauseCalendar(botId: string, target: ThreadIdentity): Promise<void>;
  changed(): void;
  onError(error: unknown): void;
};

function groupThread(group: string, member: BotGroupMember): ThreadIdentity {
  const suffix = `${group}:${member.membership}`;
  return { runtime: 'agent', threadId: GROUP_THREAD_PREFIX + suffix, branchId: 'branch:bot-group:' + suffix };
}

function summary(room: Room): BotGroupSummary {
  const last = room.posts.findLast(post => post.author.kind !== 'system');
  const conversations = new Map(room.posts.flatMap(post => post.delivery.flatMap(delivery =>
    delivery.identity ? [[delivery.membership, delivery.identity] as const] : [])));
  const members = room.members.map(member => {
    const conversation = member.calendar ?? conversations.get(member.membership);
    return conversation ? { ...member, conversation } : member;
  });
  return { id: room.id, name: room.name, members, updatedAt: room.updatedAt, ...(last ? { preview: last.text } : {}),
    active: room.posts.some(post => post.delivery.some(running)),
    needsAttention: room.posts.some(post => post.delivery.some(delivery => ['asleep', 'failed', 'execution-failed'].includes(delivery.state))) };
}

export function createBotGroupChats(options: Options) {
  const { runtime, bots, threads, workspaceId } = options;
  const changes = new Map<string, Promise<unknown>>();
  // Only active rooms are indexed in memory. All recovery data lives with the post.
  const activeRooms = new Map<string, Set<string>>();
  const backgroundThreads = new Map<string, string>();
  const wakingRooms = new Map<string, Set<string>>();
  const pending = new Map<string, boolean>();
  let stopEvents: (() => void) | undefined;
  let disposed = false;

  const decode = (record: { payloadJson: string; recordRevision: number }): Stored => ({
    room: JSON.parse(record.payloadJson) as Room, revision: record.recordRevision,
  });
  const records = async () => {
    const client = await options.client();
    const rooms: Stored[] = [];
    let cursor: number | null = null;
    do {
      const page = await client.listRecords({ workspaceId, recordType, ...(cursor !== null ? { cursor } : {}) });
      rooms.push(...page.records.map(decode));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return rooms;
  };
  const read = async (id: string, principal?: string | null) => {
    const record = await (await options.client()).getRecord(workspaceId, `${recordType}:${id}`);
    if (!record || record.recordType !== recordType) throw missing();
    const stored = decode(record);
    if (stored.room.deleted || (principal !== undefined && stored.room.principal !== principal)) throw missing();
    return stored;
  };
  const save = async (room: Room, revision?: number) => {
    const result = await (await options.client()).putRecord({
      operationId: `${recordType}:${randomUUID()}`, workspaceId, recordId: `${recordType}:${room.id}`,
      recordType, state: 'active', payloadJson: JSON.stringify(room), ownerIds: [], references: [],
      ...(revision === undefined ? {} : { expectedRecordRevision: revision }),
    });
    track(room);
    options.changed();
    return result.recordRevision;
  };
  const serial = <T>(id: string, work: () => Promise<T>) => {
    const task = (changes.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    changes.set(id, task);
    return task.finally(() => { if (changes.get(id) === task) changes.delete(id); });
  };

  function track(room: Room) {
    const identities = new Map(room.members.map(member => [member.membership, groupThread(room.id, member)]));
    const threads = new Set(room.posts.flatMap(post => post.delivery.flatMap(delivery => {
      const identity = delivery.identity ?? identities.get(delivery.membership);
      return running(delivery) && identity ? [identity.threadId] : [];
    })));
    if (!room.deleted && threads.size) activeRooms.set(room.id, threads);
    else activeRooms.delete(room.id);
    const waking = new Set(room.posts.flatMap(post => post.delivery.filter(delivery => delivery.state === 'queued' && delivery.wakeRequested).map(delivery => delivery.botId)));
    if (!room.deleted && waking.size) wakingRooms.set(room.id, waking);
    else wakingRooms.delete(room.id);
    for (const [threadId, id] of backgroundThreads) if (id === room.id) backgroundThreads.delete(threadId);
    if (!room.deleted) for (const member of summary(room).members) if (member.conversation) backgroundThreads.set(member.conversation.threadId, room.id);
  }
  const schedule = (id: string) => {
    if (disposed) return;
    if (pending.has(id)) { pending.set(id, true); return; }
    pending.set(id, false);
    void advance(id).catch(error => {
      if ((error as { status?: number }).status !== 404) options.onError(error);
    }).finally(() => {
      const again = pending.get(id);
      pending.delete(id);
      if (again) schedule(id);
    });
  };
  const recover = async () => {
    for (const { room } of await records()) {
      if (!room.deleted) {
        track(room);
        if (room.posts.some(post => post.delivery.some(running))) schedule(room.id);
        for (const member of summary(room).members) if (member.conversation) reconcileBackground(room.id, member.conversation.threadId);
      }
    }
  };
  const observe = (cursor: number) => {
    stopEvents?.();
    stopEvents = threadEventHub(runtime).subscribe(cursor, undefined, event => {
      if (event && typeof event === 'object' && 'thread_id' in event && typeof event.thread_id === 'string'
        && 'kind' in event && typeof event.kind === 'string'
        && (event.kind.startsWith('message.') || event.kind.startsWith('input.')
          || (event.kind === 'run.changed' && 'data' in event && terminal.has((event.data as { state?: string } | null)?.state ?? '')))) {
        for (const [id, ids] of activeRooms) if (ids.has(event.thread_id)) schedule(id);
        const backgroundRoom = backgroundThreads.get(event.thread_id);
        if (backgroundRoom && event.kind === 'run.changed' && 'data' in event) {
          reconcileBackground(backgroundRoom, event.thread_id, (event.data as { id?: string } | null)?.id);
        }
      }
      return true;
    }, () => undefined, []);
  };

  const chooseMember = async (botId: string): Promise<BotGroupMember> => {
    const bot = await bots.get(botId);
    if (!bot || bot.archived || bot.deletion) throw invalid('This Bot is unavailable');
    return { botId, name: bot.name, membership: randomUUID(), listening: false };
  };

  const textFor = (room: Room, post: Post) => {
    const quote = room.posts.find(candidate => candidate.id === post.quoteId);
    const cited = quote ? `\nReply context from ${quote.author.kind === 'bot' ? quote.author.name : 'the user'} (quoted history):\n${quote.text.slice(0, 900)}\n` : '';
    return `Group chat: ${room.name}\n${cited}\nUser message:\n${post.text}`;
  };

  async function* readFile(file: StoredFile, signal?: AbortSignal) {
    const client = await options.client();
    let offset = 0;
    while (offset < file.info.byteLength) {
      const page = await client.getBlob(file.hash, { ownerId: file.ownerId }, { offset, signal });
      if (page.nextOffset <= offset) throw new Error('Incomplete group file transfer');
      offset = page.nextOffset;
      yield Buffer.from(page.bytesBase64, 'base64');
    }
  }
  async function importFile(room: Room, identity: ThreadIdentity, fileId: string, signal?: AbortSignal) {
    const file = room.files?.find(value => value.info.id === fileId);
    if (!file || !room.posts.some(post => post.files?.some(value => value.id === fileId))) throw missing();
    return options.attachments.upload(identity, { ...file.info, key: `group:${room.id}:${fileId}` }, readFile(file, signal), signal);
  }

  async function advance(id: string) {
    // Prepare and observe outside room writes. The room lock orders admission and membership edits.
    const { room } = await read(id);
    const recipients = new Set(room.posts.flatMap(post => post.delivery.filter(running).map(delivery => delivery.membership)));
    await Promise.all([...recipients].map(member => advanceMember(id, member)));
  }

  async function advanceMember(id: string, membership: string) {
    const lock = `${id}:${membership}`;
    await serial(lock, async () => {
      for (;;) {
        const { room } = await read(id);
        const member = room.members.find(value => value.membership === membership);
        const post = room.posts.find(item => item.delivery.some(value => value.membership === membership && running(value)));
        if (!post || !member) return;
        const delivery = post.delivery.find(value => value.membership === membership)!;
        if (delivery.state === 'running') {
          const run = await runtime.run(delivery.runId!);
          if (!terminal.has(run.state)) return;
          const text = await answerOf(delivery.identity!.branchId, run.id);
          await serial(id, async () => {
            const latest = await read(id);
            const original = latest.room.posts.find(value => value.id === post.id)!;
            const target = original.delivery.find(value => value.membership === membership)!;
            if (target.state !== 'running' || target.runId !== run.id) return;
            target.state = run.state === 'completed' ? text ? 'answered' : 'silent' : 'execution-failed';
            if (text) latest.room.posts.push({ id: `answer:${post.id}:${membership}`, at: Date.now(), author: { kind: 'bot', botId: member.botId, name: member.name },
              text, quoteId: post.id, addressed: [], delivery: [] });
            latest.room.updatedAt = Date.now();
            await save(latest.room, latest.revision);
          });
          continue;
        }
        await serial(id, async () => {
          const latest = await read(id);
          const current = latest.room.posts.find(value => value.id === post.id)?.delivery.find(value => value.membership === membership);
          if (!current || current.state !== 'queued') return;
          const identity = groupThread(id, member);
          const source = post.origin;
          if (source && current.messageId) {
            const message = await runtime.getMessage({ ...identity, messageId: current.messageId });
            if (message.deliveredRunId) {
              current.state = 'running';
              current.runId = message.deliveredRunId;
            } else if (message.state === 'cancelled' || message.activation.state === 'failed') {
              current.state = 'execution-failed';
              current.detail = message.activation.state === 'failed' ? message.activation.code : 'Cancelled';
            } else return;
            await save(latest.room, latest.revision);
            return;
          }
          const bot = await bots.get(member.botId);
          if (!bot || !await bots.canExecute(member.botId)) {
            if (current.wakeRequested && bot?.activity?.state === 'waking') return;
            current.state = bot ? 'asleep' : 'removed';
          } else {
            try {
              await runtime.createBotThread(member.botId, identity.threadId, identity.branchId, undefined, undefined, latest.room.principal);
              const key = 'group:' + createHash('sha256').update(JSON.stringify([id, post.id, membership])).digest('hex');
              const files = await Promise.all((post.files ?? []).map(file => importFile(latest.room, identity, file.id)));
              const selections = files.map(file => ({ ref: file.ref }));
              if (source) {
                const message = await runtime.sendMessage({ key, senderThreadId: source.threadId, senderBranchId: source.branchId,
                  senderGroupOperationId: source.operationId, targetThreadId: identity.threadId, targetBranchId: identity.branchId,
                  kind: post.informs ? 'inform' : 'request', afterCurrent: true, text: `Group chat: ${latest.room.name}\n\n${post.text}`,
                  ...(files.length ? { attachments: selections, preparedAttachments: files } : {}) });
                current.identity = identity;
                current.messageId = message.messageId;
                if (post.informs) current.state = 'informed';
                delete current.wakeRequested;
                await save(latest.room, latest.revision);
                if (!post.informs) schedule(id);
                return;
              }
              const thread = await runtime.thread(identity.threadId);
              const branch = thread.branches.find(value => value.branch_id === identity.branchId)!;
              if (branch.active_run_id && current.expectedHead === undefined) return;
              const model = current.model ?? await options.model(bot);
              if (!model) throw invalid('This Bot needs a model');
              if (current.expectedHead === undefined) {
                current.expectedHead = branch.head;
                current.identity = identity;
                current.model = model;
                latest.revision = await save(latest.room, latest.revision);
              }
              const response = await withRequestPrincipal(latest.room.principal, () => threads.submit({ ...identity, key, expectedHead: current.expectedHead!,
                model, text: textFor(latest.room, post), ...(files.length ? { attachments: selections } : {}) }));
              current.state = 'running';
              current.identity = identity;
              current.runId = response.run_id;
              delete current.expectedHead;
              delete current.model;
              delete current.detail;
            } catch (error) {
              current.state = 'failed';
              current.detail = errorText(error);
              if (error instanceof ThreadPreAdmissionError) {
                delete current.expectedHead;
                delete current.model;
              }
            }
          }
          delete current.wakeRequested;
          await save(latest.room, latest.revision);
        });
        const next = await read(id);
        const target = next.room.posts.find(value => value.id === post.id)?.delivery.find(value => value.membership === membership);
        if (target?.state === 'queued') return;
      }
    });
  }

  async function answerOf(branchId: string, runId: string) {
    let before: string | undefined;
    let head: string | undefined;
    let reachedRun = false;
    const chunks: string[][] = [];
    do {
      const page = await runtime.historyPage({ branchId, limit: 20,
        ...(head ? { headId: head } : {}), ...(before ? { beforeId: before } : {}) });
      head = page.head ?? undefined;
      reachedRun ||= page.items.some(item => item.run_id === runId);
      const answers = await Promise.all(page.items.filter(item => item.run_id === runId && item.source === 'assistant').map(item => runtime.historyItem(item)));
      chunks.unshift(answers.flatMap(item => {
        const content = (item.content as { content?: { kind?: string; text?: string } })?.content;
        return content?.kind === 'text' && content.text?.trim() ? [content.text] : [];
      }));
      // Calendar recovery can observe a run after a newer one has started.
      before = reachedRun && page.items[0]?.run_id !== runId ? undefined : page.previous ?? undefined;
    } while (before);
    return chunks.flat().join('\n\n');
  }

  function reconcileBackground(id: string, threadId: string, runId?: string) {
    if (disposed) return;
    void serial(`background:${threadId}`, async () => {
      const { room } = await read(id);
      const member = summary(room).members.find(value => value.conversation?.threadId === threadId);
      if (!member?.conversation) return;
      const branchId = member.conversation.branchId;
      const handled = new Set(room.publishedBackgroundRuns);
      for (const post of room.posts) for (const delivery of post.delivery) if (delivery.runId) handled.add(delivery.runId);
      if (runId && handled.has(runId)) return;
      const publish = async (entry: { id: string; run: string; label: { scheduleName?: string; watchName?: string } }) => {
        if ((runId && entry.run !== runId) || handled.has(entry.run)) return;
        const text = await answerOf(branchId, entry.run);
        await serial(id, async () => {
          const latest = await read(id);
          if (!latest.room.members.some(value => value.membership === member.membership)) return;
          const published = latest.room.publishedBackgroundRuns ??= [];
          if (published.includes(entry.run) || latest.room.posts.some(post => post.delivery.some(delivery => delivery.runId === entry.run))) return;
          published.push(entry.run);
          if (text) {
            latest.room.posts.push({ id: entry.id, at: Date.now(), author: { kind: 'bot', botId: member.botId, name: member.name },
              text, ...entry.label, addressed: [], delivery: [] });
            latest.room.updatedAt = Date.now();
          }
          await save(latest.room, latest.revision);
          handled.add(entry.run);
        });
      };
      if (member.calendar) {
        const calendar = await runtime.calendar({ projectId: `bot:${member.botId}` });
        for (const entry of calendar.definitions) {
          if (entry.target.kind !== 'existing_work' || entry.target.threadId !== threadId || entry.target.branchId !== branchId) continue;
          for (const occurrence of await runtime.calendarOccurrences({ definitionId: entry.id })) {
            if (occurrence.run_id && terminal.has(occurrence.state)) await publish({ id: `calendar:${occurrence.id}`, run: occurrence.run_id, label: { scheduleName: entry.name } });
          }
        }
      }
      for (const watch of await runtime.followups(threadId)) {
        if (watch.branch_id !== branchId || watch.trigger.kind !== 'plugin_event') continue;
        let after: number | undefined;
        do {
          const page = await runtime.followupOccurrences(watch.id, after);
          for (const item of page.occurrences) {
            const delivery = item.delivery;
            if (delivery?.run_id && delivery.thread_id === threadId && delivery.branch_id === branchId && terminal.has(item.state)) {
              await publish({ id: `watch:${item.id}`, run: delivery.run_id, label: { watchName: watch.name ?? watch.trigger.source.sourceId } });
            }
          }
          after = page.nextCursor ?? undefined;
        } while (after !== undefined && (!runId || !handled.has(runId)));
        if (runId && handled.has(runId)) break;
      }
    }).catch(options.onError);
  }

  async function post(principal: string | null, id: string, input: GroupPostInput) {
    if (typeof input?.id !== 'string' || !input.id || typeof input.text !== 'string' || (!input.text.trim() && !input.files?.length)
      || !Array.isArray(input.addressed) || input.addressed.some(value => typeof value !== 'string')) throw invalid('A message and its recipients are required');
    if (input.files !== undefined && (!Array.isArray(input.files) || input.files.some(value => typeof value !== 'string'))) throw invalid('Invalid group files');
    await serial(id, async () => {
      const { room, revision } = await read(id, principal);
      const postId = 'user:' + input.id;
      if (room.posts.some(value => value.id === postId)) return;
      const quote = room.posts.find(value => value.id === input.quoteId);
      if (input.quoteId && !quote) throw invalid('The quoted message is unavailable');
      const addressed = [...new Set(input.addressed)];
      const reply = input.reply && quote?.author.kind === 'bot' ? quote.author.botId : null;
      const explicit = addressed.length ? addressed : reply ? [reply] : [];
      const recipients = explicit.length ? explicit.map(botId => {
        const member = room.members.find(value => value.botId === botId);
        if (!member) throw invalid('An addressed Bot has left this group');
        return member;
      }) : room.members.filter(member => member.listening);
      const files = [...new Set(input.files ?? [])].map(id => {
        const file = room.files?.find(value => value.info.id === id);
        if (!file) throw invalid('A group attachment is unavailable');
        return file.info;
      });
      room.posts.push({ id: postId, author: { kind: 'user' }, text: input.text, at: Date.now(), addressed: explicit,
        ...(quote ? { quoteId: quote.id } : {}), ...(files.length ? { files } : {}),
        delivery: recipients.map(({ botId, membership }) => ({ botId, membership, state: 'queued' })) });
      room.updatedAt = Date.now();
      await save(room, revision);
    });
    schedule(id);
  }

  async function change(principal: string | null, id: string, input: GroupChange, actor: 'user' | 'bot' = 'user') {
    if (!input || typeof input !== 'object') throw invalid('A group action is required');
    await serial(id, async () => {
      const { room, revision } = await read(id, principal);
      const member = 'botId' in input ? room.members.find(value => value.botId === input.botId) : undefined;
      if (input.kind === 'delete') {
        for (const member of summary(room).members) await pauseBackground(member);
        for (const post of room.posts) for (const delivery of post.delivery) await dropPendingHandoff(post, delivery);
        room.deleted = true;
      }
      else if (input.kind === 'add') {
        if (member) return;
        room.members.push(await chooseMember(input.botId));
      } else {
        if (!member) throw invalid('This Bot has left the group');
        if (input.kind === 'listen') {
          if (typeof input.enabled !== 'boolean') throw invalid('Invalid listening setting');
          if (member.listening === input.enabled) return;
          member.listening = input.enabled;
          member.changedBy = actor;
          room.posts.push({ id: randomUUID(), at: Date.now(), author: { kind: 'system' }, text: '', addressed: [], delivery: [],
            fact: { kind: 'listen', name: member.name, enabled: input.enabled, actor } });
        } else if (input.kind === 'remove') {
          await pauseBackground(summary(room).members.find(value => value.membership === member.membership)!);
          room.members = room.members.filter(value => value !== member);
          for (const item of room.posts) for (const delivery of item.delivery) {
            if (delivery.membership !== member.membership) continue;
            await dropPendingHandoff(item, delivery);
            if (running(delivery)) delivery.state = 'removed';
          }
        } else if (input.kind === 'retry') {
          const target = room.posts.find(value => value.id === input.postId)?.delivery.find(value => value.membership === member.membership);
          if (!target || (target.state !== 'asleep' && target.state !== 'failed')) throw invalid('This delivery is no longer retryable');
          if (target.state === 'asleep') {
            await bots.wake(member.botId);
            target.wakeRequested = true;
          }
          target.state = 'queued';
          delete target.detail;
        } else throw invalid('Unknown group action');
      }
      await save(room, revision);
      if (room.deleted && room.files?.length) {
        await (await options.client()).releaseBlobs(room.files.map(file => file.ownerId)).catch(options.onError);
      }
    });
    if (input.kind === 'retry') schedule(id);
  }

  async function pauseBackground(member: BotGroupMember) {
    if (member.calendar) await options.pauseCalendar(member.botId, member.calendar);
    if (!member.conversation) return;
    for (const watch of await runtime.followups(member.conversation.threadId)) {
      if (watch.branch_id === member.conversation.branchId && watch.trigger.kind === 'plugin_event' && watch.state === 'active') {
        await runtime.controlFollowup({ followupId: watch.id, expectedRevision: watch.revision, action: 'pause' });
      }
    }
  }

  async function dropPendingHandoff(post: Post, delivery: Delivery) {
    if (!post.origin || !delivery.messageId || !delivery.identity || !['queued', 'informed'].includes(delivery.state)) return;
    const selection = { ...delivery.identity, messageId: delivery.messageId };
    const message = await runtime.getMessage(selection);
    if (message.state !== 'queued' || message.revision === undefined) return;
    try {
      await runtime.controlMessage({ threadId: post.origin.threadId, branchId: post.origin.branchId, messageId: message.messageId,
        expectedRevision: message.revision, action: 'cancel' });
    } catch (error) {
      if ((await runtime.getMessage(selection)).state === 'queued') throw error;
    }
  }

  return {
    botChanged(botId: string) {
      for (const [id, bots] of wakingRooms) if (bots.has(botId)) schedule(id);
    },
    start() {
      const connect = () => void runtime.status().then(({ eventCursor }) => {
        if (disposed) return;
        observe(eventCursor);
        return recover();
      }).catch(options.onError);
      const stopReady = runtime.onReady(connect);
      connect();
      return () => { disposed = true; stopReady(); stopEvents?.(); };
    },
    async list(principal: string | null) {
      return (await records()).filter(({ room }) => !room.deleted && room.principal === principal)
        .map(({ room }) => summary(room)).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async create(principal: string | null, name: string, ids: string[]) {
      if (typeof name !== 'string' || !name.trim() || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw invalid('A name and at least one Bot are required');
      const room: Room = { principal, id: randomUUID(), name: name.trim(), members: await Promise.all([...new Set(ids)].map(chooseMember)), posts: [], updatedAt: Date.now() };
      await save(room);
      return summary(room);
    },
    async page(principal: string | null, id: string, before?: string, query?: string, botId?: string) {
      const { room } = await read(id, principal);
      if (botId && !room.members.some(member => member.botId === botId)) throw missing();
      const end = before ? room.posts.findIndex(value => value.id === before) : room.posts.length;
      if (end < 0) throw invalid('Invalid history position');
      const needle = query?.toLocaleLowerCase();
      const matches = room.posts.slice(0, end).filter(value => !needle || value.text.toLocaleLowerCase().includes(needle) || value.files?.some(file => file.filename.toLocaleLowerCase().includes(needle)));
      const posts = matches.slice(-40).map(({ origin: _origin, ...post }) => {
        const quoted = post.quoteId ? room.posts.find(value => value.id === post.quoteId) : undefined;
        return {
          ...post,
          ...(quoted ? { quote: { text: (quoted.text || quoted.files?.map(file => file.filename).join(', ') || '').slice(0, 240),
            ...(quoted.author.kind === 'bot' ? { author: quoted.author.name } : {}) } } : {}),
          delivery: post.delivery.map(({ expectedHead: _, model: _model, messageId: _message, wakeRequested: _wake, ...delivery }) => delivery),
        };
      });
      return { ...summary(room), posts, ...(matches.length > posts.length ? { before: posts[0]!.id } : {}) };
    },
    post, change,
    async upload(principal: string | null, id: string, info: GroupChatFile, bytes: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
      if (!info.id || !Number.isSafeInteger(info.byteLength) || info.byteLength < 0) throw invalid('Invalid attachment metadata');
      try { validateAttachmentFilename(info.filename); }
      catch (error) { throw invalid(errorText(error)); }
      await read(id, principal);
      const client = await options.client();
      const operationId = 'group-file:' + createHash('sha256').update(JSON.stringify([id, info.id])).digest('hex');
      const object = await client.putBlobStream(bytes, { operationId, byteLength: info.byteLength }, signal);
      return serial(id, async () => {
        const { room, revision } = await read(id, principal);
        const file = { ...info, mimeType: attachmentMimeType(info.filename, info.mimeType) };
        const previous = room.files?.find(value => value.info.id === info.id);
        if (previous) {
          if (previous.hash !== object.hash || previous.info.filename !== info.filename || previous.info.mimeType !== file.mimeType) throw invalid('The original attachment has changed');
          return previous.info;
        }
        (room.files ??= []).push({ info: file, hash: object.hash, ownerId: object.ownerId });
        await save(room, revision);
        return file;
      });
    },
    async file(principal: string | null, id: string, fileId: string, signal?: AbortSignal) {
      const { room } = await read(id, principal);
      const file = room.files?.find(value => value.info.id === fileId);
      if (!file || !room.posts.some(post => post.files?.some(value => value.id === fileId))) throw missing();
      return { info: file.info, bytes: readFile(file, signal) };
    },
    async postContext(principal: string | null, id: string, postId: string) {
      const { room } = await read(id, principal);
      const index = room.posts.findIndex(post => post.id === postId);
      if (index < 0) throw missing();
      return this.page(principal, id, room.posts[index + 15]?.id);
    },
    async files(principal: string | null, id: string) {
      const { room } = await read(id, principal);
      return [...new Map(room.posts.flatMap(post => (post.files ?? []).map(file => [file.id, file] as const))).values()];
    },
    async botFile(principal: string | null, id: string, botId: string, identity: ThreadIdentity, reference: string, signal?: AbortSignal) {
      const { room } = await read(id, principal);
      if (!room.members.some(value => value.botId === botId)) throw missing();
      const matches = (room.files ?? []).filter(value => value.info.id === reference || value.info.id.slice(0, 8) === reference);
      if (matches.length !== 1) throw missing();
      return importFile(room, identity, matches[0]!.info.id, signal);
    },
    async calendarTarget(principal: string | null, id: string, botId: string) {
      return serial(id, async () => {
        const { room, revision } = await read(id, principal);
        const member = room.members.find(value => value.botId === botId);
        if (!member) throw missing();
        if (member.calendar) return member.calendar;
        if (!await bots.canExecute(botId)) throw invalid('Wake the Bot before scheduling work');
        const target = groupThread(id, member);
        await runtime.createBotThread(botId, target.threadId, target.branchId, undefined, undefined, principal);
        member.calendar = target;
        await save(room, revision);
        return target;
      });
    },
    async botGroups(principal: string | null, botId: string) {
      return (await records()).flatMap(({ room }) => !room.deleted && room.principal === principal && room.members.some(value => value.botId === botId) ? [room] : []);
    },
    async botPost(principal: string | null, id: string, botId: string, origin: GroupOrigin, text: string, quoteId?: string, addressed: string[] = [], informs = false, work?: BotGroupPost['work'], attachmentRefs: string[] = [], signal?: AbortSignal) {
      if (!text.trim() && !attachmentRefs.length && !work) throw invalid('Write a group message to post');
      const postId = `bot:${origin.operationId}`;
      const roomAtStart = (await read(id, principal)).room;
      if (!roomAtStart.members.some(value => value.botId === botId)) throw missing();
      const files: GroupChatFile[] = [];
      for (const reference of [...new Set(attachmentRefs)]) {
        const identity: ThreadIdentity = { runtime: 'agent', threadId: origin.threadId, branchId: origin.branchId };
        const reader = options.attachments;
        const first = await reader.readChunk(identity, reference, 0, undefined, signal);
        const fileId = createHash('sha256').update(JSON.stringify([postId, reference])).digest('hex');
        const bytes = async function* () {
          let page = first;
          for (;;) {
            const body = Buffer.from(page.bytesBase64, 'base64');
            if (body.length) yield body;
            if (page.eof) return;
            page = await reader.readChunk(identity, reference, page.nextOffset, undefined, signal);
          }
        };
        files.push(await this.upload(principal, id, { id: fileId, filename: first.attachment.filename, mimeType: first.attachment.mimeType,
          byteLength: first.attachment.byteLength }, bytes(), signal));
      }
      await serial(id, async () => {
        const { room, revision } = await read(id, principal);
        const member = room.members.find(value => value.botId === botId);
        if (!member) throw missing();
        if (room.posts.some(value => value.id === postId)) return;
        if (quoteId && !room.posts.some(value => value.id === quoteId)) throw invalid('The quoted message is unavailable');
        const recipients = [...new Set(addressed)].map(botId => {
          const target = room.members.find(member => member.botId === botId);
          if (!target || target === member) throw invalid('Choose another group member for the handoff');
          return target;
        });
        room.posts.push({ id: postId, at: Date.now(), author: { kind: 'bot', botId, name: member.name }, origin, text, informs,
          ...(quoteId ? { quoteId } : {}), ...(work ? { work } : {}), addressed: recipients.map(member => member.botId),
          ...(files.length ? { files } : {}),
          delivery: recipients.map(({ botId, membership }) => ({ botId, membership, state: 'queued' })) });
        room.updatedAt = Date.now();
        await save(room, revision);
      });
      if (addressed.length) schedule(id);
    },
  };
}

export type BotGroupChats = ReturnType<typeof createBotGroupChats>;
