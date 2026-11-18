import type { SettingsPageMeta, SettingsRuntimeContext } from './page-types';

export const BUILTIN_SETTINGS_EXTENSION_ID = 'varin.builtin.settings';

export type BuiltinSettingsRenderer =
  | 'history'
  | 'storage'
  | 'usage'
  | 'devices'
  | 'remote-access'
  | 'proxy'
  | 'workspaces'
  | 'code-intel'
  | 'browsers'
  | 'varin:editor'
  | 'varin:terminal'
  | 'agent-memory'
  | 'agent-prompt'
  | 'empty'
  | 'about'
  | 'extensions'
  | 'git'
  | 'projects'
  | 'model-roles'
  | 'model-connections'
  | 'external-agents'
  | 'companion'
  | 'mcp-connections'
  | 'skills'
  | 'varin:general'
  | 'varin:visual'
  | 'varin:chat'
  | 'varin:notifications'
  | 'varin:shortcuts'
  | 'varin:voice';

type BuiltinSettingsPageMeta = SettingsPageMeta & Required<Pick<SettingsPageMeta, 'titleKey'>>;

export interface BuiltinSettingsPageSpec {
  availability?: 'not-mobile' | 'desktop';
  meta: BuiltinSettingsPageMeta;
  renderer: BuiltinSettingsRenderer;
}

const spec = (
  meta: BuiltinSettingsPageMeta,
  renderer: BuiltinSettingsRenderer,
  availability?: BuiltinSettingsPageSpec['availability'],
): BuiltinSettingsPageSpec => ({ meta, renderer, ...(availability ? { availability } : {}) });

export const BUILTIN_SETTINGS_PAGE_SPECS: readonly BuiltinSettingsPageSpec[] = [
  spec({ slug: 'browsers', title: 'Browser', titleKey: 'settings.browser.title', group: 'harness', kind: 'single', icon: 'global', order: 8.1, keywords: ['browser', 'chrome', 'edge', 'cdp', '浏览器', '浏览器连接'] }, 'browsers'),
  spec({ slug: 'external-agents', title: 'External Agents', titleKey: 'external.title', group: 'harness', kind: 'single', icon: 'terminal', order: 1.5, keywords: ['external', 'harness', 'codex', 'claude', 'pi', 'acp'] }, 'external-agents'),
  spec({ slug: 'history', title: 'History and recovery', titleKey: 'settings.page.history.title', group: 'general', kind: 'single', icon: 'chat-history', order: 8, keywords: ['history and recovery'] }, 'history'),
  spec({ slug: 'storage', title: 'Storage', titleKey: 'settings.page.storage.title', group: 'general', kind: 'single', icon: 'database-2', order: 7, keywords: ['storage'] }, 'storage'),
  spec({ slug: 'editor', title: 'Editor', titleKey: 'settings.page.editor.title', group: 'projects', kind: 'single', icon: 'code-box', order: 1, keywords: ['editor'] }, 'varin:editor'),
  spec({ slug: 'terminal', title: 'Terminal', titleKey: 'settings.page.terminal.title', group: 'projects', kind: 'single', icon: 'terminal', order: 2, keywords: ['terminal'] }, 'varin:terminal'),
  spec({ slug: 'model-roles', title: 'Model roles', titleKey: 'settings.roles.title', group: 'harness', kind: 'single', icon: 'stack', order: 0.4, keywords: ['model roles', 'planning', 'embedding', 'rerank', '模型分工', '规划'] }, 'model-roles'),
  spec({ slug: 'model-connections', title: 'Model channels', titleKey: 'settings.models.title', group: 'harness', kind: 'single', icon: 'cloud', order: 0, keywords: ['models', 'channels', 'credentials', 'api', '模型', '渠道'] }, 'model-connections'),
  spec({ slug: 'usage', title: 'Usage', titleKey: 'usage.title', group: 'harness', kind: 'single', icon: 'bar-chart-2', order: 0.5, keywords: ['usage', 'cost', 'tokens', '用量', '费用', 'cache'] }, 'usage'),
  spec({ slug: 'mcp-connections', title: 'MCP', titleKey: 'settings.mcp.title', group: 'connections', kind: 'single', icon: 'plug-2', order: 5, keywords: ['mcp', 'servers', 'tools', 'oauth'] }, 'mcp-connections'),
  spec({ slug: 'agent-memory', title: 'Memory', titleKey: 'assistant.memory.title', group: 'harness', kind: 'single', icon: 'database-2', order: 4, keywords: ['memory', 'global', 'project', 'session'] }, 'agent-memory'),
  spec({ slug: 'agent-prompt', title: 'System prompt', titleKey: 'assistant.prompt.title', group: 'harness', kind: 'single', icon: 'file-text', order: 3, keywords: ['prompt', 'instructions', 'style', 'autonomy'] }, 'agent-prompt'),
  spec({ slug: 'home', title: 'Settings', titleKey: 'settings.view.home.title', group: 'general', kind: 'single', icon: null, order: -1, keywords: ['search', 'settings'] }, 'empty'),
  spec({ slug: 'general', title: 'General', titleKey: 'settings.page.general.title', group: 'general', kind: 'single', icon: 'settings-3', order: 0, keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'language', 'locale', 'time', 'week', 'pwa'] }, 'varin:general'),
  spec({ slug: 'appearance', title: 'Appearance', titleKey: 'settings.page.appearance.title', group: 'general', kind: 'single', icon: 'palette', order: 1, keywords: ['theme', 'font', 'spacing', 'motion', 'animation', 'reduced motion', '动效', 'padding', 'corner radius', 'radius', 'input bar', 'viewport', 'appearance'] }, 'varin:visual'),
  spec({ slug: 'companion', title: 'Desktop companion', titleKey: 'companion.library.title', group: 'general', kind: 'single', icon: 'workbench-bot', order: 1.5, keywords: ['companion', 'desktop', 'pet', 'download', 'artwork', 'wake', 'sleep', '桌宠', '形象', '唤醒', '沉睡', '下载'] }, 'companion', 'desktop'),
  spec({ slug: 'chat', title: 'Chat', titleKey: 'settings.page.chat.title', group: 'general', kind: 'single', icon: 'chat-ai-3', order: 2, keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'] }, 'varin:chat'),
  spec({ slug: 'notifications', title: 'Notifications', titleKey: 'settings.page.notifications.title', group: 'general', kind: 'single', icon: 'notification-3', order: 4, keywords: ['alerts', 'native', 'summary', 'summarization'] }, 'varin:notifications'),
  spec({ slug: 'shortcuts', title: 'Shortcuts', titleKey: 'settings.page.shortcuts.title', group: 'general', kind: 'single', icon: 'command', order: 6, keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'] }, 'varin:shortcuts', 'not-mobile'),
  spec({ slug: 'voice', title: 'Voice', titleKey: 'settings.page.voice.title', group: 'general', kind: 'single', icon: 'mic', order: 5, keywords: ['tts', 'speech', 'voice'] }, 'varin:voice'),
  spec({ slug: 'about', title: 'About', titleKey: 'settings.page.about.title', group: 'connections', kind: 'single', icon: 'information', order: 99, keywords: ['about', 'version', 'updates', 'release', 'changelog'] }, 'about'),
  spec({ slug: 'projects', title: 'Projects', titleKey: 'settings.page.projects.title', group: 'projects', kind: 'split', icon: 'folders', order: 0, keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'] }, 'projects'),
  spec({ slug: 'git', title: 'Git', titleKey: 'settings.page.git.title', group: 'projects', kind: 'single', icon: 'git-branch', order: 3, keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'] }, 'git'),
  spec({ slug: 'skills', title: 'Skills', titleKey: 'settings.page.skills.title', group: 'connections', kind: 'split', icon: 'sparkling', order: 6, keywords: ['skill', 'skills', 'skill.md', 'markdown', 'package resource'] }, 'skills'),
  spec({ slug: 'extensions', title: 'Varin Extensions', titleKey: 'settings.page.extensions.title', group: 'connections', kind: 'single', icon: 'plug-2', order: 8, keywords: ['varin', 'extension', 'extensions', 'enable', 'disable', 'capabilities', 'plugin', 'plugins', '插件', '执行循环', 'loop', 'marketplace'] }, 'extensions'),
  spec({ slug: 'workspaces', title: 'Workspaces', titleKey: 'settings.page.workspaces.title', group: 'connections', kind: 'single', icon: 'hard-drive-2', order: 2.5, keywords: ['workspace', 'location', 'folder', 'directory', 'start', '工作区', '工作位置', '文件夹', '起始目录', '跨设备'] }, 'workspaces'),
  spec({ slug: 'code-intel', title: 'Code intelligence', titleKey: 'settings.page.codeIntel.title', group: 'projects', kind: 'single', icon: 'braces', order: 4, keywords: ['language', 'languages', 'lsp', 'language server', 'tree-sitter', 'structure', 'retrieval', 'rerank', 'code search', '语言', '语言服务', '代码检索', '重排', '代码智能'] }, 'code-intel'),
  spec({ slug: 'devices', title: 'Devices', titleKey: 'settings.page.devices.title', group: 'connections', kind: 'single', icon: 'computer', order: 0, keywords: ['device', 'devices', 'service', 'server', 'switch', 'remote instances', 'ssh', 'pairing', 'resource', 'node', 'host', 'merge', 'local service', '设备', '服务', '切换', '远程实例', '工作设备', '连接关系', '合并', '本地服务'] }, 'devices'),
  spec({ slug: 'remote-access', title: 'Remote access', titleKey: 'settings.page.remoteAccess.title', group: 'connections', kind: 'single', icon: 'qr-code', order: 1, keywords: ['remote access', 'pairing', 'qr', 'revoke', 'logout', 'password', 'passkey', 'lan', 'relay', 'tunnel', 'cloudflare', 'ngrok', 'https', 'reverse proxy', 'frp', 'external access', 'awake', '远程访问', '配对', '二维码', '撤销', '局域网', '中继', '隧道', '公网', '反向代理', '唤醒'] }, 'remote-access'),
  spec({ slug: 'proxy', title: 'Network proxy', titleKey: 'settings.page.proxy.title', group: 'connections', kind: 'single', icon: 'router', order: 2, keywords: ['proxy', 'outbound network', 'direct', 'pac', 'system proxy', 'http', 'socks', '代理', '出站网络', '直连', '系统代理'] }, 'proxy'),
];

export const isBuiltinSettingsPageAvailable = (
  spec: BuiltinSettingsPageSpec,
  context: SettingsRuntimeContext,
): boolean => spec.availability === 'desktop' ? context.isDesktop && !context.isMobile : spec.availability === 'not-mobile' ? !context.isMobile : true;
