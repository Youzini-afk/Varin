import type { IconName } from '@/components/icon/icons';

export type DesignMode = 'workbench' | 'bot' | 'ide';
export type Folder = { id: string; parent: string | null; kind: 'group' | 'project'; name: string; icon: IconName; color?: string };
export type Conversation = {
  id: string; parent: string | null; title: string; time: string; bot?: string;
  direct?: boolean; childOf?: string; state?: 'working' | 'waiting' | 'unread'; pinned?: boolean; archived?: boolean;
};
export const bots = [{ id: 'varin', name: 'Varin', color: 'theme' }, { id: 'research', name: '研究助手', color: 'original' }];
export const folders: Folder[] = [
  { id: 'work', parent: null, kind: 'group', name: '工作', icon: 'briefcase' },
  { id: 'varin-project', parent: 'work', kind: 'project', name: 'Varin', icon: 'code-box', color: 'var(--syntax-type)' },
  { id: 'release', parent: 'varin-project', kind: 'group', name: '版本发布', icon: 'rocket' },
  { id: 'design', parent: 'varin-project', kind: 'group', name: '产品设计', icon: 'palette' },
  { id: 'docs', parent: 'work', kind: 'project', name: '文档站', icon: 'book-open', color: 'var(--syntax-string)' },
  { id: 'research', parent: null, kind: 'group', name: '长期调研', icon: 'lightbulb' },
];
export const conversations: Conversation[] = [
  { id: 'release-talk', parent: 'release', title: '准备下一个版本', time: '刚刚', bot: 'varin', direct: true, pinned: true },
  { id: 'release-task', parent: 'release', title: '发布前的回归检查', time: '8 分钟', bot: 'varin', state: 'working' },
  { id: 'release-child', parent: 'release', childOf: 'release-task', title: '核对 Windows 安装流程', time: '6 分钟', bot: 'varin', state: 'waiting' },
  { id: 'notes', parent: 'release', title: '更新说明与改动整理', time: '昨天', bot: 'varin', state: 'unread' },
  { id: 'navigation', parent: 'design', title: '会话分类与导航体验', time: '今天', pinned: true },
  { id: 'theme', parent: 'design', title: '浅色主题的层级和对比', time: '昨天' },
  { id: 'docs-task', parent: 'docs', title: '补充远程部署说明', time: '昨天', bot: 'varin' },
  { id: 'native', parent: 'research', title: '桌面框架与浏览器方案', time: '昨天', bot: 'research', direct: true },
  { id: 'quick', parent: null, title: '一个临时的问题', time: '周二' },
];
export function folderPath(all: Folder[], id: string | null): Folder[] {
  const result: Folder[] = [];
  while (id) { const folder = all.find(item => item.id === id); if (!folder) break; result.unshift(folder); id = folder.parent; }
  return result;
}
