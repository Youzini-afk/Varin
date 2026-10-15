import path from 'node:path';
import type { ThreadIdentity, ThreadSnapshot, ThreadModel, ThreadPreparedSource, ThreadResolvedSource } from '@varin/application-client';
import type { HistoryItem, InputSubmitReceipt, Run, ThreadSummary } from '@varin/protocol';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import { commandKey, requestThreadApi, requestVarinApi, waitForRun } from './cli-runtime.js';
import { printJson, isJsonMode, isQuietMode } from '../cli-output.js';
import { recordOf, type CliOptions } from './cli-types.js';

const required = (value: unknown, flag: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new TunnelCliError(`Missing required ${flag}.`, EXIT_CODE.USAGE_ERROR);
  return value.trim();
};
export const parseThreadModel = (options: CliOptions): ThreadModel => {
  const value = required(options.model, '--model'); const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new TunnelCliError('--model must use provider/model.', EXIT_CODE.USAGE_ERROR);
  const thinking = options.thinking;
  if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new TunnelCliError('Invalid --thinking level.', EXIT_CODE.USAGE_ERROR);
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1), ...(thinking ? { thinkingLevel: thinking as NonNullable<ThreadModel['thinkingLevel']> } : {}) };
};
const identityFromOptions = (options: CliOptions): ThreadIdentity => ({ runtime: 'agent', threadId: required(options.thread, '--thread'), branchId: required(options.branch, '--branch') });
const output = (options: CliOptions, value: unknown): void => {
  if (isJsonMode(options)) printJson(value); else process.stdout.write(`${JSON.stringify(value, null, isQuietMode(options) ? undefined : 2)}\n`);
};
const prepareWorkspace = async (port: number, identity: ThreadIdentity, key: string, options: CliOptions): Promise<ThreadPreparedSource | undefined> => {
  let directory = options.directory;
  if (directory && options.project) throw new TunnelCliError('Choose --dir or --project.', EXIT_CODE.USAGE_ERROR);
  if (options.project) {
    const settings = await requestVarinApi(port, '/api/config/settings', options);
    const project = (Array.isArray(settings.projects) ? settings.projects : []).map(recordOf).find(item => item.id === options.project);
    directory = required(project?.path, 'a valid --project');
  }
  if (!directory) return undefined;
  const mode = options.sourceMode ?? 'fixed_branch';
  if (!['fixed_branch', 'materialized', 'live_root'].includes(mode)) throw new TunnelCliError('--source-mode must be fixed_branch, materialized, or live_root.', EXIT_CODE.USAGE_ERROR);
  const resolved = await requestThreadApi<ThreadResolvedSource>(port, 'source/resolve', { ...identity, resourceOwner: { kind: 'local' }, path: path.resolve(directory) }, options);
  return requestThreadApi(port, 'source/prepare', { ...identity, key: `${key}:source`, resourceOwner: resolved.resourceOwner,
    workspaceId: resolved.workspaceId, mode, content: { mode: 'saved-files' }, captureScopes: [] }, options);
};

export const threadCommand = async (options: CliOptions = {}, action = 'help'): Promise<void> => {
  if (action === 'help') {
    process.stdout.write(`Varin Thread Commands\n\n  varin thread list [--all]\n  varin thread create [--prompt <text> --model <provider/model>]\n  varin thread send --thread <id> --branch <id> --prompt <text> --model <provider/model>\n  varin thread fork --thread <id> --branch <id> [--message <history-id>]\n  varin thread status --thread <id> --branch <id>\n  varin thread messages --thread <id> --branch <id>\n\nOptions: --key <stable-request-key>, --expected-head <id|null>, --dir <path> or --project <id>,\n  --source-mode <fixed_branch|materialized|live_root>, --thinking <level>,\n  --goal, --goal-token-budget <tokens>, --wait, --timeout <seconds>, --json.\n\nA generated request key is printed before mutation. Reuse it after an uncertain reply.\n--wait follows the original accepted Run through completion, failure, or cancellation.\n`); return;
  }
  if (!['list', 'create', 'send', 'fork', 'status', 'messages'].includes(action)) throw new TunnelCliError(`Unknown thread command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  if (options.timeout && !options.wait) throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
  const port = await resolveTargetPort(options);
  if (action === 'list') {
    const threads = await requestThreadApi<ThreadSummary[]>(port, 'list', { archived: options.all ? 'include' : 'exclude' }, options);
    output(options, { threads }); return;
  }
  if (action === 'status' || action === 'messages') {
    const identity = identityFromOptions(options);
    const snapshot = await requestThreadApi<ThreadSnapshot>(port, 'snapshot', identity, options);
    if (action === 'status') { output(options, snapshot); return; }
    const history: HistoryItem[] = [...snapshot.history]; let before = snapshot.historyPage.previous;
    while (before && snapshot.historyPage.head) {
      const page = await requestThreadApi<{ items: HistoryItem[]; previous: string | null }>(port, 'history/page', { ...identity, headId: snapshot.historyPage.head, beforeId: before }, options);
      history.unshift(...page.items); before = page.previous;
    }
    output(options, { identity, history }); return;
  }
  const text = action === 'send' ? required(options.prompt, '--prompt') : options.prompt;
  const model = text ? parseThreadModel(options) : undefined;
  if (options.goal && !text) throw new TunnelCliError('--goal requires --prompt.', EXIT_CODE.USAGE_ERROR);
  if (options.key && action !== 'create' && options.expectedHead === undefined && !(action === 'fork' && options.message)) throw new TunnelCliError('Retry with the original --expected-head printed before submission (use null for an empty branch).', EXIT_CODE.USAGE_ERROR);
  const key = commandKey(options);
  let identity = action === 'create' ? await requestThreadApi<ThreadIdentity>(port, 'create', { key }, options) : identityFromOptions(options);
  let snapshot = await requestThreadApi<ThreadSnapshot>(port, 'snapshot', identity, options);
  let forkHead: string | null | undefined;
  if (action === 'fork') {
    forkHead = options.message ?? (options.expectedHead === 'null' ? null : typeof options.expectedHead === 'string' ? options.expectedHead : snapshot.historyPage.head);
    process.stderr.write(`Retry head: --expected-head ${forkHead ?? 'null'}\n`);
    identity = await requestThreadApi<ThreadIdentity>(port, 'fork', { ...identity, key, headId: forkHead }, options);
    snapshot = await requestThreadApi<ThreadSnapshot>(port, 'snapshot', identity, options);
  }
  if (action === 'create' && (options.title || options.name)) await requestThreadApi(port, 'update', { runtime: 'agent', threadId: identity.threadId, key: `${key}:title`, expectedRevision: 1, title: options.title || options.name }, options);
  let receipt: InputSubmitReceipt | undefined; let run: Run | undefined;
  if (text && model) {
    const prepared = await prepareWorkspace(port, identity, key, options);
    const expectedHead = action === 'create' ? null : action === 'fork' ? forkHead! : options.expectedHead !== undefined ? (options.expectedHead === 'null' ? null : String(options.expectedHead)) : snapshot.historyPage.head;
    process.stderr.write(`Retry head: --expected-head ${expectedHead ?? 'null'}\n`);
    receipt = await requestThreadApi<InputSubmitReceipt>(port, 'submit', { ...identity, key: `${key}:input`, expectedHead,
      text, model, ...(prepared ? { source: prepared.source } : {}) }, options);
    if (options.goal) {
      const budget = parseGoalTokenBudget(options);
      await requestThreadApi(port, 'goal/start', { ...identity, key: `${key}:goal`, runId: receipt.run_id, objective: text,
        budget: budget === undefined ? null : { maxOutputTokens: budget } }, options);
    }
    if (options.wait) run = await waitForRun(port, receipt.run_id, options);
  }
  output(options, { key, identity, ...(receipt ? { receipt } : {}), ...(run ? { run } : {}) });
  if (run && run.state !== 'completed') throw new TunnelCliError(`Run ${run.id} ended ${run.state}.`, EXIT_CODE.GENERAL_ERROR);
};
