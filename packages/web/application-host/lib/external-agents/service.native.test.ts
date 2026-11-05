import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';
import { ExternalAgentsService } from './service.js';
import type { KernelManagedProcess } from '../kernel/process-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { idle?: { preparedMs: number; conversationMs: number; sweepMs: number }; descendant?: boolean } = {}) {
  const harness = createNativeProcessTestHarness();
  cleanups.push(() => harness.dispose());
  const native = await harness.get();
  const directory = path.join(native.root, 'external');
  await mkdir(directory);
  const script = path.join(directory, 'codex-fixture.mjs');
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
if (${options.descendant === true}) spawn(process.execPath, ['-e',
  'const fs = require("node:fs"); setInterval(() => fs.writeFileSync("descendant-heartbeat", String(Date.now())), 20)'], { stdio: 'ignore' });
let count = 0, active;
const reply = (id, result) => send({jsonrpc:'2.0',id,result});
const event = (method, params) => send({jsonrpc:'2.0',method,params:{threadId:'native-thread',turnId:active,...params}});
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, {userAgent:'fixture'});
  if (m.method === 'thread/start' || m.method === 'thread/resume') reply(m.id,{thread:{id:'native-thread'}});
  if (m.method === 'model/list') reply(m.id,{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture'}]});
  if (m.method === 'turn/start') {
    active = 'turn-' + ++count;
    reply(m.id,{turn:{id:active}}); event('turn/started',{turn:{id:active}});
    const input = m.params.input[0].text;
    if (input === 'disconnect') { process.exit(1); return; }
    event('item/started',{item:{id:'answer-'+count,type:'agentMessage',text:''}});
    event('item/agentMessage/delta',{itemId:'answer-'+count,delta:'收到：'+input});
    if (input === 'permission') send({jsonrpc:'2.0',id:'permission',method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:active,command:'fixture',availableDecisions:['accept','decline']}});
    else event('turn/completed',{turn:{id:active,status:'completed'}});
  }
  if (m.id === 'permission' && m.result?.decision === 'accept') event('turn/completed',{turn:{id:active,status:'completed'}});
  if (m.method === 'turn/interrupt') { reply(m.id,{}); event('turn/completed',{turn:{id:active,status:'interrupted'}}); }
});
`,
  );
  const processes: KernelManagedProcess[] = [];
  const service = new ExternalAgentsService({
    kernel: native.client,
    spawn: async (...args) => {
      const child = await native.service.spawn(...args);
      if (args[1]?.includes('app-server')) processes.push(child);
      return child;
    },
    directory,
    ...(options.idle ? { idle: options.idle } : {}),
    resolveWorkspace: async (cwd) => {
      const { workspaceId } = await native.documents.resolveWorkspace({ path: cwd });
      return { workspaceId, root: (await native.documents.inspectWorkspace(workspaceId)).root };
    },
  });
  cleanups.push(() => service.close());
  const settings = await service.settings();
  await service.configure(
    {
      defaultAgent: null,
      agents: [
        {
          id: 'fixture',
          name: 'Fixture',
          harness: 'codex',
          enabled: true,
          command: process.execPath,
          args: [script],
        },
      ],
    },
    settings.revision,
    'configure',
  );
  const conversation = await service.create({
    key: 'conversation',
    configurationId: 'fixture',
    cwd: directory,
  });
  return { service, conversation, native, processes, directory };
}

it('round-trips external input, real protocol approval, queued turns and durable history without a native model Run', async () => {
  const { service, conversation } = await fixture();
  expect((await service.detect('fixture')).status).toBe('available');
  const first = await service.send(conversation.id, 'first', { text: 'permission' });
  const duplicate = await service.send(conversation.id, 'first', { text: 'permission' });
  expect(duplicate.id).toBe(first.id);
  const second = await service.send(conversation.id, 'second', { text: '第二轮' });
  await vi.waitFor(async () => expect((await service.read(conversation.id)).interactions).toHaveLength(1), {
    timeout: 15_000,
  });
  const approvalId = (await service.read(conversation.id)).interactions[0]!.id;
  await service.respond(conversation.id, approvalId, { optionId: 'accept' });
  await vi.waitFor(
    async () =>
      expect((await service.read(conversation.id)).turns.find((v) => v.id === second.id)?.status).toBe(
        'completed',
      ),
    { timeout: 15_000 },
  );
  const snapshot = await service.read(conversation.id);
  expect(snapshot.conversation.sessionId).toBe('native-thread');
  expect(snapshot.turns).toHaveLength(2);
  expect(snapshot.items.filter((v) => v.kind === 'assistant').map((v) => v.text)).toEqual([
    '收到：permission',
    '收到：第二轮',
  ]);
  expect(snapshot.interactions).toEqual([]);
  expect(snapshot.conversation.activeTurn).toBeUndefined();
  const stopping = await service.send(conversation.id, 'stop-after-permission', { text: 'permission' });
  await vi.waitFor(async () => expect((await service.read(conversation.id)).interactions).toHaveLength(1), {
    timeout: 15_000,
  });
  const expiredApprovalId = (await service.read(conversation.id)).interactions[0]!.id;
  await service.stop(conversation.id, stopping.id);
  await vi.waitFor(
    async () =>
      expect((await service.read(conversation.id)).turns.find((t) => t.id === stopping.id)?.status).toBe(
        'cancelled',
      ),
    { timeout: 15_000 },
  );
  await expect(service.respond(conversation.id, expiredApprovalId, { optionId: 'accept' })).rejects.toThrow();
});

it('keeps an interrupted external input and does not automatically replay it', async () => {
  const { service, conversation } = await fixture();
  const sent = await service.send(conversation.id, 'disconnect', { text: 'disconnect' });
  await vi.waitFor(
    async () =>
      expect((await service.read(conversation.id)).turns.find((v) => v.id === sent.id)?.status).toBe(
        'interrupted',
      ),
    { timeout: 15_000 },
  );
  const repeated = await service.send(conversation.id, 'disconnect', { text: 'disconnect' });
  expect(repeated.id).toBe(sent.id);
  expect((await service.read(conversation.id)).turns).toHaveLength(1);
});

it('reclaims a real unobserved process tree, preserves Catalog binding and cached capabilities, and resumes the same native session', async () => {
  const { service, conversation, processes, directory } = await fixture({
    idle: { preparedMs: 100, conversationMs: 200, sweepMs: 25 }, descendant: true,
  });
  const unsubscribe = service.subscribe(conversation.id, () => true);
  await service.connect(conversation.id);
  const first = processes[0]!;
  await vi.waitFor(async () => expect(await readFile(path.join(directory, 'descendant-heartbeat'), 'utf8')).not.toBe(''), { timeout: 15_000 });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(first.exitConfirmed).toBe(false);
  unsubscribe();
  await vi.waitFor(async () => expect((await service.read(conversation.id)).connection?.status).toBe('reclaimed'), { timeout: 15_000 });
  expect(first.exitConfirmed).toBe(true);
  await first.completion;
  const stoppedHeartbeat = await readFile(path.join(directory, 'descendant-heartbeat'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await readFile(path.join(directory, 'descendant-heartbeat'), 'utf8')).toBe(stoppedHeartbeat);
  const reclaimed = await service.read(conversation.id);
  expect(reclaimed.conversation.sessionId).toBe('native-thread');
  expect(reclaimed.turns).toEqual([]);
  expect(reclaimed).toMatchObject({ connected: false, capabilitiesSource: 'cached', capabilities: { models: [{ id: 'fixture-model' }] } });
  const observing = service.subscribe(conversation.id, () => true);
  await service.connect(conversation.id);
  expect(processes).toHaveLength(2);
  const resumed = await service.read(conversation.id);
  expect(resumed).toMatchObject({ connected: true, capabilitiesSource: 'live', conversation: { id: conversation.id, sessionId: 'native-thread' } });
  expect(resumed.turns).toEqual([]);
  observing();
});
