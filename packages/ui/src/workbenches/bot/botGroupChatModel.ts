import React from 'react';
import { botGroupRequest, type BotGroupSummary } from '@varin/application-client';
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
} as const;
export function groupLabel(key: keyof typeof labels) {
  const locale = getCurrentIntlLocale().toLowerCase();
  return labels[key][locale.startsWith('zh') ? /tw|hk|hant/.test(locale) ? 2 : 1 : 0];
}
export const groupChatError = (value: unknown) => value instanceof Error ? value.message : String(value);

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
