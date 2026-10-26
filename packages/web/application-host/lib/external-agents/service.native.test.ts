import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';
import { ExternalAgentsService } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
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
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
let count = 0, active;
const reply = (id, result) => send({jsonrpc:'2.0',id,result});
const event = (method, params) => send({jsonrpc:'2.0',method,params:{threadId:'native-thread',...params}});
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
  if (m.id === 'permission' && m.result) event('turn/completed',{turn:{id:active,status:'completed'}});
  if (m.method === 'turn/interrupt') { reply(m.id,{}); event('turn/completed',{turn:{id:active,status:'interrupted'}}); }
});
`,
  );
  const service = new ExternalAgentsService({
    kernel: native.client,
    spawn: native.service.spawn,
    directory,
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
  return { service, conversation, native };
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
  await service.respond(conversation.id, 'permission', { optionId: 'accept' });
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
  await service.stop(conversation.id, stopping.id);
  await vi.waitFor(
    async () =>
      expect((await service.read(conversation.id)).turns.find((t) => t.id === stopping.id)?.status).toBe(
        'cancelled',
      ),
    { timeout: 15_000 },
  );
  await expect(service.respond(conversation.id, 'permission', { optionId: 'accept' })).rejects.toThrow();
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
