import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import { SCHEDULE_CAPABILITY, createScheduleToolOwner } from './schedule-tool-owner.js';
import { retainExtensionTool } from './extension-tool-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall } from './tool-bridge.js';
import type { CalendarOccurrence, ExecutorOwner, LaunchIntent, LaunchSource, Run } from './protocol.generated.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import type { CalendarOwner } from '../scheduled-tasks/calendar-owner.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
/** Real installed SDK/broker/retained lease and actual project asset service. The
 * management and native calendar ports are fixtures, not native kernel IPC. */
it('the ordinary scheduled task example edits its admitted project and returns native acceptance through original tool receipts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-schedule-extension-'));
  let extensions: ApplicationExtensionRuntime | undefined;
  let retained: Awaited<ReturnType<typeof retainExtensionTool>> | undefined;
  const config = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'config') });
  const scheduler = createScheduledTasksRuntime({ projectConfigRuntime: config, listProjects: async () => [{ id: 'project', path: root }], executeTask: async () => { throw new Error('Pi must not run'); } });
  const occurrence = { id: 'original-occurrence', state: 'preparing', thread_id: 'cold-thread', run_id: null } as CalendarOccurrence;
  const runCalendar = vi.fn(async () => occurrence);
  scheduler.setCalendarOwner({ sync: async (_id: string, tasks: unknown) => tasks, run: runCalendar, stop() {} } as unknown as CalendarOwner);
  const service = createScheduledTaskService({ projectConfigRuntime: config, scheduledTasksRuntime: scheduler,
    readSettingsFromDisk: async () => ({ projects: [{ id: 'project', path: root }] }), sanitizeProjects: value => value as Array<{ id: string; path: string }> });
  try {
    const source = path.join(repository, 'examples/extensions/scheduled-task-tool');
    const installed = path.join(root, 'example'); await fs.mkdir(installed);
    await fs.copyFile(path.join(source, 'package.json'), path.join(installed, 'package.json'));
    const manifest = parseVarinExtensionManifest(JSON.parse(await fs.readFile(path.join(source, 'varin.extension.json'), 'utf8')));
    const descriptor = manifest.provides!.services![0]!;
    await fs.writeFile(path.join(installed, 'varin.extension.json'), JSON.stringify(manifest));
    const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
    await build({ entryPoints: [path.join(source, 'host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(installed, 'host.cjs'),
      alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
    extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.25', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    const workspaceRoot = vi.fn(async (workspace: string) => { if (workspace !== 'original-workspace') throw new Error('Unadmitted workspace'); return root; });
    extensions.capabilities.register(SCHEDULE_CAPABILITY, createScheduleToolOwner({ service, workspaceRoot }));
    await extensions.start();
    await extensions.installOrStage({ source: { kind: 'local', display: 'Project schedule example', specifier: installed }, expectedRevision: (await extensions.catalog.snapshot()).revision });
    await extensions.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await extensions.catalog.snapshot()).revision,
      decisions: [{ capability: SCHEDULE_CAPABILITY, realm: 'host', granted: true }] });
    await extensions.setEnabled(manifest.id, true, (await extensions.catalog.snapshot()).revision);
    const selected = await extensions.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: 'execute', args: [], routing: { sessionId: 'thread' } });
    const sourceBinding: LaunchSource = { workspace_id: 'original-workspace', execution_workspace_id: 'source-execution', branch_id: 'source-branch', revision: 1, mode: 'fixed_branch', live_root: null, environment_run_id: 'source-run' };
    const run = { id: 'run', thread_id: 'thread', branch_id: 'branch', state: 'executing', revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null } as Run;
    const launch = { run_id: run.id, selection: { source: sourceBinding } } as LaunchIntent;
    const owner: ExecutorOwner = { kind: 'external', identity: selected.providerKey, epoch: 'executor' };
    let invocation: HostToolCall, managementArguments: unknown;
    const kernel = { agentRuntimeRequest: async (method: string) => {
      if (method === 'runtime.operation.inspect') return { id: invocation.operationId, run_id: invocation.runId, phase: 'running', cancel_requested: false, execution_owner: owner,
        intent: { origin: invocation.origin, call: { call_id: invocation.callId, name: invocation.name, schema_version: invocation.schemaVersion, arguments: managementArguments ?? invocation.arguments } } };
      if (method === 'runtime.run.inspect') return run;
      if (method === 'runtime.launch.inspect') return launch;
      throw new Error(`Unexpected management request ${method}`);
    } } as unknown as KernelClient;
    retained = await retainExtensionTool({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [{ tool: 'scheduled_task', decision: 'allow' }] }) }, selected);
    let count = 0;
    const execute = async (args: unknown, policy = false) => {
      const callId = `schedule-${++count}`;
      invocation = { runId: run.id, operationId: policy ? `policy:node:${callId}` : `request:tool:${callId}`, origin: policy ? { kind: 'policy_action', action_id: 'policy', node_id: callId } : { kind: 'model_step', request_id: 'request' },
        callId, name: 'scheduled_task', schemaVersion: retained!.binding.tool.version, arguments: args };
      const signal = new AbortController().signal;
      await retained!.lease.authorize(invocation, signal);
      return retained!.lease.execute(invocation, signal, owner);
    };
    const task = { name: 'Original calendar', runtime: 'agent', enabled: false, execution: { prompt: 'Original instruction' }, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      target: { kind: 'new_work', model: { providerId: 'fixture', modelId: 'model', temperature: 0 }, sourceMode: 'fixed_branch', goal: null } };
    expect(await execute({ action: 'upsert', task })).toMatchObject({ completion: { outcome: 'succeeded', effect: 'confirmed' }, executor_stopped: true });
    const [stored] = await config.listScheduledTasks('project');
    expect(stored?.execution).toEqual(task.execution); expect(stored?.target).toEqual(task.target);
    expect(await execute({ action: 'run', taskId: stored!.id }, true)).toMatchObject({ completion: { outcome: 'succeeded', effect: 'confirmed', content: { runtime: 'agent', occurrence } }, executor_stopped: true });
    expect(runCalendar).toHaveBeenCalledWith('project', stored!.id, 'policy:node:schedule-2');
    expect(await execute({ action: 'list' })).toMatchObject({ completion: { effect: 'none', content: { tasks: [expect.objectContaining({ id: stored!.id })] } } });
    expect(workspaceRoot.mock.calls.every(([id]) => id === 'original-workspace')).toBe(true);
    await expect(execute({ action: 'run', taskId: stored!.id, directory: '/another-project' })).rejects.toThrow('input_schema');
    managementArguments = { action: 'remove', taskId: stored!.id };
    expect(await execute({ action: 'run', taskId: stored!.id })).toMatchObject({ completion: { kind: 'not_dispatched' } });
    managementArguments = undefined;
    // The original asset write happened; losing subsequent publication is honest unknown.
    const original = service.upsert;
    vi.spyOn(service, 'upsert').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Calendar publication response lost'); });
    expect(await execute({ action: 'upsert', task: { id: stored!.id, name: 'Persisted despite lost response' } })).toMatchObject({ completion: { outcome: 'indeterminate', effect: 'unknown' }, executor_stopped: true });
    expect((await config.listScheduledTasks('project'))[0]?.name).toBe('Persisted despite lost response');
  } finally { retained?.lease.release(); await extensions?.stop(); scheduler.stop(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
