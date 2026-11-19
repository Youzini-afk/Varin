import React from 'react';
import { botGroupRequest, getRuntimeEndpointGeneration, type BotGroupMember, type BotGroupPost, type BotGroupSummary } from '@varin/application-client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerReference } from '@/components/chat/composer/editor/references';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';

const labels = {
  groups: ['Group chats', '群聊', '群聊'], create: ['New group chat', '新建群聊', '建立群聊'],
  name: ['Group name', '群名称', '群組名稱'], createAction: ['Create group', '创建群聊', '建立群聊'],
  choose: ['Choose the Bots you want to chat with.', '选择一起聊天的 Bot。', '選擇一起聊天的 Bot。'],
  members: ['Members', '成员', '成員'], activity: ['Activity', '动态', '動態'], add: ['Add members', '添加成员', '加入成員'],
  listen: ['Receive unaddressed user messages', '接收未指定对象的用户消息', '接收未指定對象的使用者訊息'],
  listening: ['Listening', '在听', '在聽'], search: ['Search group', '搜索群消息', '搜尋群組訊息'],
  older: ['Earlier messages', '更早的消息', '更早的訊息'], empty: ['Mention a member to start the conversation.', '用 @ 叫一个成员来接话。', '用 @ 叫一位成員來接話。'],
  latest: ['Latest messages', '最新消息', '最新訊息'],
  write: ['Message the group', '发消息到群里…', '傳訊息到群組…'], reply: ['Reply', '回复', '回覆'],
  quote: ['Quote', '引用', '引用'], send: ['Send', '发送', '傳送'], to: ['To', '发给', '傳給'],
  record: ['Just post', '仅记录', '僅記錄'], remove: ['Remove', '移出', '移除'], left: ['Left the group', '已离开群聊', '已離開群聊'],
  asleep: ['Asleep', '在休息', '在休息'], retry: ['Retry delivery', '重新发送', '重新傳送'],
  wakeRetry: ['Wake and retry', '唤醒并重新发送', '喚醒並重新傳送'], wake: ['Wake', '唤醒', '喚醒'],
  thinking: ['Working on this', '处理中', '處理中'], silent: ['Received without a reply', '已收到，未回复', '已收到，未回覆'],
  informed: ['Informed', '告知', '告知'],
  openWork: ['Open task', '打开任务', '開啟工作'], failed: ['Could not deliver', '未送达', '未送達'],
  workFailed: ['Execution ended without completing', '执行未完成', '執行未完成'],
  delete: ['Delete group', '删除群聊', '刪除群聊'], cancel: ['Cancel', '取消', '取消'],
  private: ['Direct chat', '私聊', '私訊'], expand: ['Read more', '展开全文', '展開全文'], collapse: ['Collapse', '收起', '收合'],
  loading: ['Loading…', '加载中…', '載入中…'],
  schedule: ['Schedule', '日程', '日程'], newSchedule: ['New schedule', '新建日程', '建立日程'],
  watch: ['Watch', '关注', '關注'],
  emptySchedule: ['No schedules in this group', '群里还没有日程', '群組尚無日程'],
  files: ['Group files', '群文件', '群組檔案'], attach: ['Attach files', '添加文件', '加入檔案'],
  mention: ['Mention a member', '提及成员', '提及成員'], mentioned: ['Mentioned', '被 @', '被 @'],
  groupMenu: ['Group actions', '群聊操作', '群聊操作'], back: ['Back', '返回', '返回'],
  idle: ['Available', '空闲', '閒置'], noListeners: ['Nobody is listening', '没有成员在听', '沒有成員在聽'],
  listeningHint: ['When a message has no mention or reply target, it goes to the members who are listening.', '没有 @、也没有回复对象的消息会发给「在听」的成员。', '沒有 @、也沒有回覆對象的訊息會傳給「在聽」的成員。'],
  listeningByBot: ['Enabled by the Bot', '由成员自己开启', '由成員自己開啟'],
  listeningByUser: ['Enabled by you', '由你开启', '由你開啟'],
  profile: ['Profile', '资料', '資料'], needs: ['Needs attention', '需要你', '需要你'],
  inProgress: ['In progress', '进行中', '進行中'], history: ['History', '记录', '記錄'],
  emptyActivity: ['No group activity yet', '群里还没有动态', '群組尚無動態'],
  emptyFiles: ['No shared files yet', '还没有分享的文件', '尚未分享檔案'],
  upcoming: ['Upcoming', '接下来', '接下來'], recurring: ['Recurring', '重复规则', '重複規則'],
  watches: ['Watches and follow-ups', '安排与关注', '安排與關注'],
  awakeToReceive: ['Can receive the message after waking', '唤醒后才会收到这条消息', '喚醒後才會收到這則訊息'],
  routeRequired: ['Clear the reply or choose another recipient', '取消回复或选择其他接收成员', '取消回覆或選擇其他接收成員'],
  recordHint: ['The message stays in the group for members to read later.', '消息会留在群里，成员之后可以查看。', '訊息會留在群組中，成員稍後可以查看。'],
  listenOff: ['Stopped listening', '关闭在听', '關閉在聽'],
  noResults: ['No matching messages', '没有匹配的消息', '沒有相符的訊息'],
  mentionPlaceholder: ['@ a member to bring them in', '@ 成员可让它接话', '@ 成員可讓它接話'],
  listeningSkipped: ['Listening · skipped here', '在听 · 这条不发给它', '在聽 · 這則不會傳給它'],
  quotedOnly: ['Quoted only', '仅被引用', '僅被引用'],
} as const;
export function groupLabel(key: keyof typeof labels) {
  const locale = getCurrentIntlLocale().toLowerCase();
  return labels[key][locale.startsWith('zh') ? /tw|hk|hant/.test(locale) ? 2 : 1 : 0];
}
export function groupMemberCount(count: number) {
  const locale = getCurrentIntlLocale().toLowerCase();
  if (!locale.startsWith('zh')) return `${count} ${count === 1 ? 'member' : 'members'}`;
  return `${count} 位${groupLabel('members')}`;
}
export const groupChatError = (value: unknown) => value instanceof Error ? value.message : String(value);

export type GroupDraft = { text: string; references: readonly ComposerReference[] };
export type GroupQuote = { post: BotGroupPost; reply: boolean };
export type GroupDraftFile = { id: string; file: File };
export const emptyGroupDraft: GroupDraft = { text: '', references: [] };

export function placeGroupMention(editor: ComposerEditorHandle | null, botId: string, name: string) {
  editor?.insertReference(0, 0, `@${name}`, {
    id: crypto.randomUUID(), host: getRuntimeEndpointGeneration(), target: { kind: 'group-member', botId },
  });
}

export function groupDraftRecipients(draft: GroupDraft, members: BotGroupMember[], quote?: GroupQuote) {
  const addressed = [...new Set(draft.references.flatMap(reference => reference.target.kind === 'group-member'
    && draft.text.slice(reference.from, reference.to) === reference.text ? [reference.target.botId] : []))];
  const replyTarget = quote?.reply && quote.post.author.kind === 'bot' ? quote.post.author.botId : undefined;
  const memberIds = new Set(members.map(member => member.botId));
  const replyId = replyTarget && memberIds.has(replyTarget) ? replyTarget : undefined;
  const listeners = members.filter(member => member.listening).map(member => member.botId);
  return {
    addressed, replyId, listeners,
    recipients: addressed.length ? addressed : replyId ? [replyId] : listeners,
    gone: addressed.filter(id => !memberIds.has(id)),
  };
}

export function useBotGroupChats(enabled: boolean, scope: string) {
  const [groups, setGroups] = React.useState<BotGroupSummary[]>([]);
  const [sequence, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [error, setError] = React.useState('');
  React.useEffect(() => { setGroups([]); setError(''); }, [scope]);
  React.useEffect(() => enabled ? subscribeVarinEvents(event => {
    if (event.type === 'bot-group-chat-changed' || event.type === 'stream-ready') refresh();
  }) : undefined, [enabled]);
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void botGroupRequest<BotGroupSummary[]>('', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) { setGroups(value); setError(''); }
    }, error => { if (!controller.signal.aborted) setError(groupChatError(error)); });
    return () => controller.abort();
  }, [enabled, scope, sequence]);
  return { groups, sequence, refresh, error };
}
