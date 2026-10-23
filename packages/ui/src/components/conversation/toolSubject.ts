import type { useI18n } from '@/lib/i18n';
import type { ChatToolCall } from './types';
import { toolRecord, toolText } from './toolInvocation';
import { processCommand, type ToolTargets } from './toolTargetContext';
import { toolValueLabel } from './toolLabels';
import { readUserQuestions } from '@varin/protocol';

type Translate = ReturnType<typeof useI18n>['t'];
const words = ['read', 'search', 'update', 'list', 'create', 'add', 'remove', 'share', 'inspect', 'save', 'export', 'open', 'launch',
  'click', 'type', 'key', 'scroll', 'drag', 'write', 'insert', 'navigate', 'evaluate', 'screenshot', 'pause', 'resume', 'cancel', 'stage', 'apply', 'start', 'stop',
  'request', 'deny', 'control', 'release', 'prepare', 'install', 'register'] as const;
export function toolActionLabel(value: unknown, t: Translate): string {
  const word = toolText(value);
  const action = word === 'get' || word === 'recall' ? 'read' : word === 'delete' || word === 'forget' ? 'remove'
    : word === 'remember' ? 'save' : word === 'correct' ? 'update' : word === 'describe' ? 'inspect'
      : word === 'set_value' ? 'write' : ['status', 'environment'].includes(word) ? 'inspect'
        : ['docs', 'tabs', 'apps', 'access'].includes(word) ? 'list' : ['observe', 'snapshot'].includes(word) ? 'read'
          : word === 'grant' ? 'apply' : word === 'artifact' ? 'register' : word;
  return words.includes(action as typeof words[number]) ? t(`chat.toolAction.${action as typeof words[number]}`) : word;
}
const list = (value: unknown) => Array.isArray(value) ? value : [];
export const subjectJoin = (...values: unknown[]) => values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' · ');
const paths = (value: unknown) => list(value).map(item => typeof item === 'string' ? item : toolText(toolRecord(item).path)).filter(Boolean).join(', ');
const count = (value: unknown, t: Translate) => Array.isArray(value) ? t('chat.tools.entries', { count: value.length }) : '';

/** Subjects come from declared parameters and returned facts, never from guessed argument JSON. */
export function toolSubject(call: Pick<ChatToolCall, 'name' | 'arguments'>, data: Record<string, unknown>, t: Translate, targets?: ToolTargets | null): string {
  const args = toolRecord(call.arguments), action = toolActionLabel(args.action, t);
  const child = (id: unknown) => targets?.children.get(toolText(id)) || toolText(id);
  const thread = (id: unknown) => targets?.threads.get(toolText(id)) || toolText(id);
  switch (call.name) {
    case 'process_spawn': case 'process_write': case 'process_read': case 'process_inspect': case 'process_resize': case 'process_stop': case 'wait_process': {
      const snapshot = toolRecord(data.process ?? data.snapshot ?? data);
      const id = toolText(args.processId) || toolText(snapshot.processId);
      const target = processCommand(args) || targets?.processes.get(id) || (typeof snapshot.pid === 'number' ? 'PID ' + snapshot.pid : id);
      const input = toolText(args.text).replace(/\r\n|\r|\n/g, ' ↵ ').replace(/\t/g, ' ⇥ ').trim();
      return subjectJoin(target, call.name === 'process_write' ? subjectJoin(input, args.eof === true ? 'EOF' : '')
        : call.name === 'process_resize' && typeof args.cols === 'number' && typeof args.rows === 'number' ? `${args.cols} × ${args.rows}` : '');
    }
    case 'todo': {
      const items = list(args.items).map(toolRecord);
      const step = items.find(item => item.status === 'in_progress') ?? items.find(item => item.status === 'pending') ?? items[0];
      return toolText(step?.text) || action;
    }
    case 'memory': return subjectJoin(['save', 'delete'].includes(toolText(args.action)) ? '' : action,
      toolText(args.query) || toolText(args.content) || toolText(toolRecord(data.item).content) || toolText(args.id), toolValueLabel(args.scope, t));
    case 'goal_report': return subjectJoin(toolValueLabel(args.state === 'complete' ? 'completed' : args.state, t), args.reason);
    case 'child_status': case 'child_report': case 'wait_child': case 'child_cancel': return subjectJoin(child(args.operationId), call.name === 'child_report' ? args.itemId : undefined);
    case 'threads': return subjectJoin(args.query, args.filePath, args.parentThreadId ? thread(args.parentThreadId) : undefined, count(data.members, t));
    case 'read_thread': return subjectJoin(thread(args.threadId), toolRecord(args.query).text, count(toolRecord(data.page).items, t));
    case 'agent_rename': return subjectJoin(args.agentId, typeof args.name === 'string' ? '→ ' + args.name : '');
    case 'submit_code': case 'update': return subjectJoin(thread(args.target ?? args.source), paths(args.files));
    case 'settings_search': return subjectJoin(toolActionLabel('search', t), args.query, args.category, args.id, count(data.items, t));
    case 'settings_read': return subjectJoin(toolActionLabel('read', t), args.id, toolValueLabel(args.scope, t));
    case 'settings_update': {
      const items = Array.isArray(args.items) ? args.items.map(toolRecord) : [args];
      return subjectJoin(toolActionLabel('update', t), items.map(item => subjectJoin(item.id, [...Object.keys(toolRecord(item.set)), ...list(item.reset).filter(value => typeof value === 'string')].join(', '))).filter(Boolean).join(' · '));
    }
    case 'settings_action': return subjectJoin(args.id, toolActionLabel(args.verb, t));
    case 'tool_describe': return toolText(args.name) || toolText(args.namespace) || count(data.groups ?? data.tools, t);
    case 'resource_read': return subjectJoin(toolText(data.title) || toolText(data.name), args.relativePath, args.targetPath, args.file, args.view);
    case 'ask_user': return readUserQuestions(args)[0]?.question ?? '';
    case 'question_status': return toolValueLabel(data.status, t);
    case 'recovery_points': return subjectJoin(paths(args.paths), args.point, args.operation, count(data.points, t));
    case 'file_restore': return subjectJoin(paths(args.paths), toolText(toolRecord(data.point).label),
      Array.isArray(data.appliedPaths) ? t('chat.toolSummary.restoredFiles', { count: data.appliedPaths.length }) : '',
      Array.isArray(data.conflictPaths) && data.conflictPaths.length ? t('chat.tools.restoreConflicts', { count: data.conflictPaths.length }) : '');
    case 'materials': {
      const member = toolRecord(args.member), collection = toolRecord(data.collection);
      return subjectJoin(action, toolText(collection.name) || toolText(args.name) || toolText(args.collectionId) || toolText(args.snapshotId),
        args.query, toolText(member.title) || toolText(toolRecord(member.paper).title) || toolText(member.url) || toolText(args.memberId),
        args.targetThreadId ? '→ ' + thread(args.targetThreadId) : '', count(data.hits ?? data.collections ?? collection.members, t));
    }
    case 'runtime_contract': return subjectJoin(action, args.serviceId ?? args.id ?? args.name ?? args.kind, toolRecord(args.member).name, args.path);
    case 'extension_package': return subjectJoin(action, args.packagePath ?? args.extensionId, toolValueLabel(data.outcome, t));
    case 'follow_up': return subjectJoin(action, args.instruction ?? data.instruction, count(data.followups, t));
  }
  if (call.name.startsWith('environment_forward')) {
    const access = toolRecord(data.access), service = toolRecord(access.service), local = toolRecord(access.access);
    const address = typeof args.port === 'number' ? `${toolText(args.host) || 'localhost'}:${args.port}`
      : typeof service.port === 'number' ? `${toolText(service.host)}:${service.port}` : toolText(args.operationId);
    return subjectJoin(toolActionLabel(call.name === 'environment_forward' ? 'open' : call.name.endsWith('_close') ? 'stop'
      : call.name.endsWith('_wait') ? '' : call.name.endsWith('_get') ? 'inspect' : 'list', t), address, local.url ? '→ ' + toolText(local.url) : '', count(data.jobs, t));
  }
  if (call.name.startsWith('computer_')) {
    const act = toolRecord(args.act ?? args.action), response = toolRecord(data.result), doc = toolRecord(response.doc);
    const observation = toolRecord(data.observation ?? response.observation), app = toolRecord(observation.app);
    const verb = toolActionLabel(act.kind ?? args.op ?? args.action ?? call.name.slice(9), t);
    const target = toolText(doc.title) || toolText(args.path) || toolText(args.url) || toolText(args.relativePath)
      || toolText(act.doc) || toolText(act.app) || toolText(args.app) || toolText(app.name) || toolText(args.query)
      || toolText(args.command) || toolText(args.requestId) || toolText(toolRecord(data.desktop).label) || toolText(args.desktopId);
    const position = typeof act.elementIndex === 'number' ? '#' + act.elementIndex
      : typeof act.x === 'number' && typeof act.y === 'number' ? `(${act.x}, ${act.y})` : '';
    return subjectJoin(verb, target, subjectJoin(act.sheet, act.range), act.url ?? act.path, act.key ?? act.text ?? act.value,
      act.direction, position, paths(args.packages ?? args.groups), count(response.tabs ?? response.docs ?? data.apps ?? data.desktops, t));
  }
  if (call.name.startsWith('mcp_')) {
    const input = call.name.startsWith('mcp__') ? args : toolRecord(args.arguments);
    return subjectJoin(args.uri ?? args.name ?? args.taskId ?? args.operationId,
      typeof input.owner === 'string' && typeof input.repo === 'string' ? input.owner + '/' + input.repo : '',
      input.query ?? input.title ?? input.path ?? input.url ?? input.name ?? toolRecord(data.structuredContent).title,
      count(data.resources ?? data.resourceTemplates ?? data.prompts ?? data.tools ?? data.contents ?? data.servers, t));
  }
  return '';
}
