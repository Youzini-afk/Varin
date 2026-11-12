import type { IconName } from '@/components/icon/icons';
import type {
  DesktopSshInstance,
  DesktopSshPortForward,
} from '@/lib/desktopSsh';

export type ProjectActionIconKey =
  | 'play'
  | 'build'
  | 'lint'
  | 'terminal'
  | 'tools'
  | 'bug'
  | 'flask'
  | 'rocket'
  | 'code'
  | 'server'
  | 'branch'
  | 'search'
  | 'settings'
  | 'brain'
  | 'stack'
  | 'robot'
  | 'command'
  | 'file';

export const PROJECT_ACTION_ICONS: Array<{
  key: ProjectActionIconKey;
  label: string;
  Icon: IconName;
  iconName: IconName;
}> = [
  { key: 'play', label: 'Play', iconName: 'play', Icon: 'play' },
  { key: 'build', label: 'Build', iconName: 'hammer', Icon: 'hammer' },
  { key: 'lint', label: 'Lint', iconName: 'checkbox-circle', Icon: 'checkbox-circle' },
  { key: 'terminal', label: 'Terminal', iconName: 'terminal-box', Icon: 'terminal-box' },
  { key: 'tools', label: 'Tools', iconName: 'tools', Icon: 'tools' },
  { key: 'bug', label: 'Bug', iconName: 'bug', Icon: 'bug' },
  { key: 'flask', label: 'Flask', iconName: 'flask', Icon: 'flask' },
  { key: 'rocket', label: 'Rocket', iconName: 'rocket', Icon: 'rocket' },
  { key: 'code', label: 'Code', iconName: 'code', Icon: 'code' },
  { key: 'server', label: 'Server', iconName: 'server', Icon: 'server' },
  { key: 'branch', label: 'Branch', iconName: 'git-branch', Icon: 'git-branch' },
  { key: 'search', label: 'Search', iconName: 'search', Icon: 'search' },
  { key: 'settings', label: 'Settings', iconName: 'settings-3', Icon: 'settings-3' },
  { key: 'brain', label: 'Brain', iconName: 'brain-ai-3', Icon: 'brain-ai-3' },
  { key: 'stack', label: 'Stack', iconName: 'stack', Icon: 'stack' },
  { key: 'robot', label: 'Robot', iconName: 'robot-2', Icon: 'robot-2' },
  { key: 'command', label: 'Command', iconName: 'command', Icon: 'command' },
  { key: 'file', label: 'File', iconName: 'file-text', Icon: 'file-text' },
];

export const PROJECT_ACTION_ICON_MAP = Object.fromEntries(
  PROJECT_ACTION_ICONS.map((entry) => [entry.key, entry.iconName])
) as Record<ProjectActionIconKey, IconName>;

export const PROJECT_ACTION_ICON_COMPONENT_MAP = Object.fromEntries(
  PROJECT_ACTION_ICONS.map((entry) => [entry.key, entry.Icon])
) as Record<ProjectActionIconKey, IconName>;

export const PROJECT_ACTIONS_UPDATED_EVENT = 'varin:project-actions-updated';

export const normalizeProjectActionDirectory = (value: string): string => {
  const trimmed = (value || '').trim().replace(/\\/g, '/');
  if (!trimmed) {
    return '';
  }
  if (trimmed === '/') {
    return '/';
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
};

export const toProjectActionRunKey = (directory: string, actionId: string,resourceOwner?:import('@varin/protocol').SourceResourceOwner, selection?:import('@varin/application-client').ProjectSourceSelection): string => {
  const original=`${normalizeProjectActionDirectory(directory)}::${actionId}`;
  return resourceOwner?.kind==='managed_host'?JSON.stringify([resourceOwner.hostId,resourceOwner.connectionId,resourceOwner.endpointIdentity,original,selection??null]):original;
};

export type ProjectActionDesktopForwardOption = {
  id: string;
  label: string;
  url: string;
};

const toBrowserHost = (host: string | undefined): string => {
  const value = (host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }
  return value;
};

const normalizePort = (value: number | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 65535) {
    return null;
  }
  return rounded;
};

const buildForwardOption = (instance: DesktopSshInstance, forward: DesktopSshPortForward): ProjectActionDesktopForwardOption | null => {
  if (!forward.enabled || forward.type !== 'local') {
    return null;
  }

  const localPort = normalizePort(forward.localPort);
  const remotePort = normalizePort(forward.remotePort);
  if (!localPort || !remotePort) {
    return null;
  }

  const localHost = toBrowserHost(forward.localHost || instance.localForward.bindHost || '127.0.0.1');
  const remoteHost = (forward.remoteHost || '127.0.0.1').trim();
  const instanceLabel = (instance.nickname || instance.id || 'instance').trim();

  return {
    id: `${instance.id}::${forward.id}`,
    label: `${instanceLabel} - ${localHost}:${localPort} -> ${remoteHost}:${remotePort}`,
    url: `http://${localHost}:${localPort}`,
  };
};

export const buildProjectActionDesktopForwardOptions = (
  instances: DesktopSshInstance[]
): ProjectActionDesktopForwardOption[] => {
  const options: ProjectActionDesktopForwardOption[] = [];

  for (const instance of instances) {
    if (!instance?.id || !Array.isArray(instance.portForwards)) {
      continue;
    }
    for (const forward of instance.portForwards) {
      const option = buildForwardOption(instance, forward);
      if (option) {
        options.push(option);
      }
    }
  }

  return options;
};

export const resolveProjectActionDesktopForwardUrl = (
  selectionId: string | undefined,
  instances: DesktopSshInstance[]
): string | null => {
  const key = (selectionId || '').trim();
  if (!key) {
    return null;
  }
  const options = buildProjectActionDesktopForwardOptions(instances);
  const matched = options.find((entry) => entry.id === key);
  return matched?.url || null;
};
