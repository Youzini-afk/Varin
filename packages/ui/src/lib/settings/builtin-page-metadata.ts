import type { SettingsPageMeta, SettingsRuntimeContext } from './page-types';

export const BUILTIN_SETTINGS_EXTENSION_ID = 'varin.builtin.settings';

export type BuiltinSettingsRenderer =
  | 'history'
  | 'storage'
  | 'work-connections'
  | 'network'
  | 'access'
  | 'images'
  | 'varin:editor'
  | 'varin:terminal'
  | 'agent-memory'
  | 'agent-prompt'
  | 'empty'
  | 'about'
  | 'commands'
  | 'extensions'
  | 'git'
  | 'language-support'
  | 'projects'
  | 'model-connections'
  | 'mcp-connections'
  | 'remote-instances'
  | 'skills'
  | 'varin:general'
  | 'varin:visual'
  | 'varin:chat'
  | 'varin:notifications'
  | 'varin:sessions'
  | 'varin:shortcuts'
  | 'varin:voice'
  | 'varin:tunnel';

export interface BuiltinSettingsPageSpec {
  availability?: 'not-mobile';
  meta: SettingsPageMeta;
  renderer: BuiltinSettingsRenderer;
}

const spec = (
  meta: SettingsPageMeta,
  renderer: BuiltinSettingsRenderer,
  availability?: BuiltinSettingsPageSpec['availability'],
): BuiltinSettingsPageSpec => ({ meta, renderer, ...(availability ? { availability } : {}) });

export const BUILTIN_SETTINGS_PAGE_SPECS: readonly BuiltinSettingsPageSpec[] = [
  spec({ slug: 'history', title: 'History and recovery', titleKey: 'settings.page.history.title', group: 'general', kind: 'single', icon: 'chat-history', order: 8, keywords: ['history and recovery'] }, 'history'),
  spec({ slug: 'storage', title: 'Storage', titleKey: 'settings.page.storage.title', group: 'general', kind: 'single', icon: 'database-2', order: 7, keywords: ['storage'] }, 'storage'),
  spec({ slug: 'editor', title: 'Editor', titleKey: 'settings.page.editor.title', group: 'projects', kind: 'single', icon: 'code-box', order: 1, keywords: ['editor'] }, 'varin:editor'),
  spec({ slug: 'terminal', title: 'Terminal', titleKey: 'settings.page.terminal.title', group: 'projects', kind: 'single', icon: 'terminal', order: 2, keywords: ['terminal'] }, 'varin:terminal'),
  spec({ slug: 'work-connections', title: 'Work connections', titleKey: 'settings.page.connections.title', group: 'connections', kind: 'single', icon: 'computer', order: 0, keywords: ['work connections'] }, 'work-connections'),
  spec({ slug: 'network', title: 'Outbound network', titleKey: 'settings.page.network.title', group: 'connections', kind: 'single', icon: 'global', order: 2, keywords: ['outbound network'] }, 'network'),
  spec({ slug: 'access', title: 'Devices and access', titleKey: 'settings.page.access.title', group: 'connections', kind: 'single', icon: 'shield-check', order: 3, keywords: ['devices', 'access', 'password', 'passkey', 'security', 'lan', 'pairing', 'revoke'] }, 'access'),
  spec({ slug: 'images', title: 'Image generation and editing', titleKey: 'settings.page.images.title', group: 'harness', kind: 'single', icon: 'file-image', order: 7, keywords: ['image generation and editing'] }, 'images'),
  spec({ slug: 'model-connections', title: 'Model channels', titleKey: 'settings.models.title', group: 'harness', kind: 'single', icon: 'cloud', order: 0, keywords: ['models', 'channels', 'credentials', 'api', '模型', '渠道'] }, 'model-connections'),
  spec({ slug: 'mcp-connections', title: 'MCP', titleKey: 'settings.mcp.title', group: 'connections', kind: 'single', icon: 'plug-2', order: 5, keywords: ['mcp', 'servers', 'tools', 'oauth'] }, 'mcp-connections'),
  spec({ slug: 'agent-memory', title: 'Memory', titleKey: 'assistant.memory.title', group: 'harness', kind: 'single', icon: 'database-2', order: 4, keywords: ['memory', 'global', 'project', 'session'] }, 'agent-memory'),
  spec({ slug: 'agent-prompt', title: 'System prompt', titleKey: 'assistant.prompt.title', group: 'harness', kind: 'single', icon: 'file-text', order: 3, keywords: ['prompt', 'instructions', 'style', 'autonomy'] }, 'agent-prompt'),
  spec({ slug: 'home', title: 'Settings', titleKey: 'settings.view.home.title', group: 'general', kind: 'single', icon: null, order: -1, keywords: ['search', 'settings'] }, 'empty'),
  spec({ slug: 'general', title: 'General', titleKey: 'settings.page.general.title', group: 'general', kind: 'single', icon: 'settings-3', order: 0, keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'language', 'locale', 'time', 'week', 'pwa'] }, 'varin:general'),
  spec({ slug: 'appearance', title: 'Appearance', titleKey: 'settings.page.appearance.title', group: 'general', kind: 'single', icon: 'palette', order: 1, keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'viewport', 'appearance'] }, 'varin:visual'),
  spec({ slug: 'chat', title: 'Chat', titleKey: 'settings.page.chat.title', group: 'general', kind: 'single', icon: 'chat-ai-3', order: 2, keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'] }, 'varin:chat'),
  spec({ slug: 'notifications', title: 'Notifications', titleKey: 'settings.page.notifications.title', group: 'general', kind: 'single', icon: 'notification-3', order: 4, keywords: ['alerts', 'native', 'summary', 'summarization'] }, 'varin:notifications'),
  spec({ slug: 'sessions', title: 'Sessions', titleKey: 'settings.page.sessions.title', group: 'general', kind: 'single', icon: 'chat-history', order: 3, keywords: ['defaults', 'default model', 'thinking', 'auxiliary model', 'title', 'inheritance'] }, 'varin:sessions'),
  spec({ slug: 'shortcuts', title: 'Shortcuts', titleKey: 'settings.page.shortcuts.title', group: 'general', kind: 'single', icon: 'command', order: 6, keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'] }, 'varin:shortcuts', 'not-mobile'),
  spec({ slug: 'voice', title: 'Voice', titleKey: 'settings.page.voice.title', group: 'general', kind: 'single', icon: 'mic', order: 5, keywords: ['tts', 'speech', 'voice'] }, 'varin:voice'),
  spec({ slug: 'about', title: 'About', titleKey: 'settings.page.about.title', group: 'connections', kind: 'single', icon: 'information', order: 99, keywords: ['about', 'version', 'updates', 'release', 'changelog'] }, 'about'),
  spec({ slug: 'projects', title: 'Projects', titleKey: 'settings.page.projects.title', group: 'projects', kind: 'split', icon: 'folders', order: 0, keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'] }, 'projects'),
  spec({ slug: 'remote-instances', title: 'Remote Instances', titleKey: 'settings.page.remoteInstances.title', group: 'connections', kind: 'single', icon: 'computer', order: 1, keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'] }, 'remote-instances'),
  spec({ slug: 'tunnel', title: 'External Tunnel', titleKey: 'settings.page.tunnel.title', group: 'connections', kind: 'single', icon: 'home-office', order: 4, badgeKey: 'settings.view.badge.beta', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'] }, 'varin:tunnel'),
  spec({ slug: 'git', title: 'Git', titleKey: 'settings.page.git.title', group: 'projects', kind: 'single', icon: 'git-branch', order: 3, keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'] }, 'git'),
  spec({ slug: 'language-support', title: 'Language Support', titleKey: 'settings.page.languageSupport.title', group: 'projects', kind: 'single', icon: 'code-box', order: 6, keywords: ['language', 'languages', 'grammar', 'tree-sitter', 'structure', 'lsp', 'language server'] }, 'language-support'),
  spec({ slug: 'commands', title: 'Commands', titleKey: 'settings.page.commands.title', group: 'connections', kind: 'single', icon: 'command', order: 7, keywords: ['command', 'commands', 'slash command', 'extension command', 'prompt command', 'skill command'] }, 'commands'),
  spec({ slug: 'skills', title: 'Skills', titleKey: 'settings.page.skills.title', group: 'connections', kind: 'split', icon: 'sparkling', order: 6, keywords: ['skill', 'skills', 'skill.md', 'markdown', 'package resource'] }, 'skills'),
  spec({ slug: 'extensions', title: 'Varin Extensions', titleKey: 'settings.page.extensions.title', group: 'connections', kind: 'single', icon: 'plug-2', order: 8, keywords: ['varin', 'extension', 'extensions', 'enable', 'disable', 'capabilities'] }, 'extensions'),
];

export const isBuiltinSettingsPageAvailable = (
  spec: BuiltinSettingsPageSpec,
  context: SettingsRuntimeContext,
): boolean => spec.availability === 'not-mobile' ? !context.isMobile : true;
