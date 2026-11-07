import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { WorkbenchCommandImplementation, WorkbenchCommandMeta } from './surface-command-types';

/** Chat exposure belongs to the original command registry, not a second command database. */
export const COMPOSER_COMMAND_DEFINITIONS: Array<{ meta: WorkbenchCommandMeta & Required<Pick<WorkbenchCommandMeta, 'titleKey'>>; implementation: WorkbenchCommandImplementation }> = [
  {"name": "new", "group": "conversation", "icon": "add", "interaction": "action", "keywords": ["new", "session"]},
  {"name": "branch", "group": "conversation", "icon": "git-branch", "interaction": "select", "keywords": ["fork", "branch"]},
  {"name": "tree", "group": "conversation", "icon": "history", "interaction": "action", "keywords": ["history", "timeline"]},
  {"name": "rename", "group": "conversation", "icon": "edit", "interaction": "select", "keywords": ["rename", "title"]},
  {"name": "pin", "group": "conversation", "icon": "pushpin", "interaction": "action", "keywords": ["pin", "unpin"]},
  {"name": "archive", "group": "conversation", "icon": "archive", "interaction": "select", "keywords": ["archive"]},
  {"name": "export", "group": "conversation", "icon": "download", "interaction": "select", "keywords": ["export", "markdown", "json"]},
  {"name": "model", "group": "execution", "icon": "brain", "interaction": "select", "keywords": ["model", "provider"]},
  {"name": "thinking", "group": "execution", "icon": "brain", "interaction": "select", "keywords": ["reasoning", "thinking"]},
  {"name": "permissions", "group": "execution", "icon": "shield-user", "interaction": "select", "keywords": ["permission", "policy"]},
  {"name": "goal", "group": "execution", "icon": "command", "interaction": "action", "keywords": ["goal"]},
  {"name": "context", "group": "context", "icon": "pie-chart", "interaction": "action", "keywords": ["context"]},
  {"name": "compact", "group": "context", "icon": "scissors", "interaction": "action", "keywords": ["compact", "summary"]},
  {"name": "usage", "group": "context", "icon": "command", "interaction": "action", "keywords": ["usage", "tokens"]},
  {"name": "tasks", "group": "collaboration", "icon": "task", "interaction": "action", "keywords": ["tasks", "agents"]},
  {"name": "contact", "group": "collaboration", "icon": "send-plane", "interaction": "select", "keywords": ["contact", "message", "agent"]},
  {"name": "handoff", "group": "collaboration", "icon": "share-forward", "interaction": "select", "keywords": ["handoff", "delegate"]},
  {"name": "schedule", "group": "collaboration", "icon": "timer", "interaction": "action", "keywords": ["schedule", "followup"]},
  {"name": "bot", "group": "collaboration", "icon": "robot", "interaction": "select", "keywords": ["handoff", "varin", "bot"]},
  {"name": "attachments", "group": "resources", "icon": "command", "interaction": "select", "keywords": ["attachments", "files"]},
  {"name": "memory", "group": "resources", "icon": "book", "interaction": "action", "keywords": ["memory", "notes"]},
  {"name": "remember", "group": "resources", "icon": "save-3", "interaction": "select", "keywords": ["remember", "save"]},
  {"name": "mcp", "group": "resources", "icon": "plug", "interaction": "action", "keywords": ["mcp", "connections"]},
  {"name": "terminal", "group": "resources", "icon": "terminal-box", "interaction": "action", "keywords": ["terminal", "shell"]},
  {"name": "settings", "group": "application", "icon": "settings-3", "interaction": "action", "keywords": ["settings", "preferences"]},
  {"name": "shortcuts", "group": "application", "icon": "command", "interaction": "action", "keywords": ["shortcuts", "keyboard"]},
  {"name": "pet", "group": "application", "icon": "emotion-happy", "interaction": "action", "keywords": ["pet", "companion"]},
  {"name": "delete", "group": "management", "icon": "delete-bin", "interaction": "select", "keywords": ["delete", "remove"]},
  {"name": "skills", "group": "skills", "icon": "sparkling", "interaction": "action", "keywords": ["skills", "manage"]},
].map((entry, order) => ({
  meta: { commandId: `composer.${entry.name}`, titleKey: `composer.command.${entry.name}` as WorkbenchCommandMeta['titleKey'] & string,
    icon: entry.icon as WorkbenchCommandMeta['icon'], order: 100 + order, keywords: entry.keywords,
    composer: { name: entry.name, group: entry.group as NonNullable<WorkbenchCommandMeta['composer']>['group'], interaction: entry.interaction as 'action' | 'select' } },
  implementation: { isAvailable: context => Boolean(context.composer?.actions[entry.name]), execute: async context => {
    if (!context.composer || context.composer.host !== getRuntimeEndpointGeneration()) throw new Error('Conversation target changed');
    const action = context.composer.actions[entry.name];
    if (!action) throw new Error('Command is unavailable in this conversation');
    if (action.disabled) throw new Error(action.disabled);
    await action.run?.();
  } },
}));
