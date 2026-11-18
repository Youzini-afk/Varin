const english = {
  title: 'Workspaces', description: 'Save project and folder locations for conversations on this service.',
  service: 'Connected Varin service', start: 'New conversation starting location', fallback: 'Service default directory',
  startHint: 'Applies to new ordinary conversations only. Existing conversations, projects and Bots keep their own locations.',
  saved: 'Saved locations', empty: 'No locations saved yet.', addFolder: 'Save a folder', addProject: 'Save a project',
  folder: 'Folder', project: 'Project', device: 'Device', name: 'Display name', path: 'Folder on this device', choose: 'Choose…',
  add: 'Save location', remove: 'Remove bookmark', refresh: 'Refresh', loading: 'Loading…', saving: 'Saving…', done: 'Saved',
  noDevices: 'No available file devices.', noProjects: 'No more registered projects to add.',
  missingProject: 'Project no longer registered', offline: 'Device unavailable', local: 'Service device',
  stale: 'This selection changed on the service. Review the updated locations and try again.',
  discovery: 'Resource discovery is unavailable.', duplicate: 'This location is already saved.',
  removeHint: 'Removing a bookmark does not remove the project or its files.',
};
const chinese: typeof english = {
  title: '工作区', description: '保存项目和文件夹的位置，供这台服务上的会话使用。',
  service: '当前 Varin 服务', start: '普通新会话的起始位置', fallback: '服务默认目录',
  startHint: '只影响新建的普通会话。已有会话、项目和 Bot 保留各自的工作位置。',
  saved: '常用位置', empty: '还没有保存工作位置。', addFolder: '收藏文件夹', addProject: '收藏项目',
  folder: '文件夹', project: '项目', device: '设备', name: '显示名称', path: '此设备上的目录', choose: '请选择…',
  add: '保存位置', remove: '移除收藏', refresh: '刷新', loading: '正在加载…', saving: '正在保存…', done: '已保存',
  noDevices: '没有可用的文件设备。', noProjects: '没有其他已登记项目可添加。',
  missingProject: '项目已取消登记', offline: '设备不可用', local: '服务所在设备',
  stale: '服务上的位置已变化，请核对最新列表后重试。',
  discovery: '暂时无法获取设备列表。', duplicate: '此位置已收藏。', removeHint: '移除收藏不会删除项目或其中的文件。',
};
export const workspaceCopy = (locale: string) => locale.startsWith('zh') ? chinese : english;
