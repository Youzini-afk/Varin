import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [image, releaseId, platform = 'linux/amd64'] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image ?? '') || !/^image-[a-f0-9]{40}$/.test(releaseId ?? '') || !['linux/amd64', 'linux/arm64'].includes(platform)) {
  throw new Error('Use an immutable image digest and exact release identity');
}
const name = `varin-node-check-${randomUUID()}`;
const data = '/home/varin/.config/varin';
const workspace = '/home/varin/workspaces';
const privateDir = '/home/varin/.ssh';
const privateName = `${name}-pairing`;
const bearerFile = `${privateDir}/ci-client.json`;
const workspaceName = `${name}-workspace`;
const mount = ['--mount', `type=volume,src=${name},dst=${data}`, '--mount', `type=volume,src=${workspaceName},dst=${workspace}`];
const docker = (args, capture = false) => execFileSync('docker', args,
  { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const ephemeral = ['run', '--rm', '--platform', platform, ...mount, '--mount', `type=volume,src=${privateName},dst=${privateDir}`];
const checkAbsent = `test ! -e packages/web/dist && test ! -e packages/web/server/index.js && test -z "$(find '${data}' -type d -name agent-runtime -print -quit)"`;
try {
  docker(['pull', '--platform', platform, image]);
  docker(['volume', 'create', name]);
  docker(['volume', 'create', workspaceName]);
  docker(['volume', 'create', privateName]);
  docker([...ephemeral, image, 'pair', '--output', bearerFile]);
  // The short-lived test credential stays in the runner process/volume. Never
  // interpolate it into docker arguments, logs, assertion messages or errors.
  let token;
  try { token = JSON.parse(docker([...ephemeral, '--entrypoint', 'cat', image, bearerFile], true)).token; }
  catch { throw new Error('Could not read private fixture pairing output'); }
  if (typeof token !== 'string' || !token) throw new Error('Missing fixture bearer');

  const start = async () => {
    docker(['run', '--detach', '--name', name, '--platform', platform, ...mount, '--publish', '127.0.0.1::3000', image]);
    const port = /^127\.0\.0\.1:(\d+)$/u.exec(docker(['port', name, '3000/tcp'], true).trim())?.[1];
    if (!port) throw new Error('Could not determine the loopback fixture port');
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < (platform === 'linux/arm64' ? 120 : 60); attempt++) {
      const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (health?.ok) {
        const body = await health.json();
        assert.equal(body.role, 'resources');
        assert.equal(body.releaseId, releaseId);
        return origin;
      }
      if (docker(['inspect', '--format', '{{.State.Running}}', name], true).trim() !== 'true') throw new Error('Resource node stopped before ready');
      await delay(1000);
    }
    throw new Error('Resource node did not become ready');
  };
  const request = (origin, route, body, authenticated = true) => fetch(`${origin}/api/harness/managed-execution/v1${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const positive = async response => {
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await start();
  assert.equal((await request(first, '/identity', undefined, false)).status, 401);
  assert.equal((await fetch(`${first}/`, { signal: AbortSignal.timeout(5000) })).status, 404);
  const identity = await positive(await request(first, '/identity'));
  assert.equal(typeof identity.hostId, 'string');
  assert.equal((await request(first, '/documents/workspace/resolve', { path: data })).status, 403);
  const registration = await positive(await request(first, '/documents/workspace/resolve', { path: workspace }));
  assert.equal(typeof registration.workspaceId, 'string');
  docker(['exec', name, 'sh', '-ec', `printf 'node fixture\\n' > '${workspace}/status.txt'; ${checkAbsent}`]);
  const { workspaceId } = registration;
  assert.equal(registration.hostId, identity.hostId);
  const resource = { workspaceId, resourceId: 'status.txt' };
  const read = origin => request(origin, '/documents/read', { resource }).then(positive);
  const original = await read(first);
  assert.equal(original.status, 'ready');
  assert.equal(original.content, 'node fixture\n');
  assert.equal(typeof original.revision, 'string');

  // Raw Documents mutations are not part of this role, even with a paired client.
  const raw = await request(first, '/documents/write', {
    token: { workspaceId, epoch: original.epoch, owner: { kind: 'fixture', id: name } }, resource,
    encoding: original.encoding, bom: original.bom, expectedRevision: original.revision,
    operationId: randomUUID(), content: 'unexpected overwrite',
  });
  assert.equal(raw.status, 404);
  assert.equal((await raw.json()).code, 'resource-node-operation-unavailable');

  // The node's actual write path is a tool on a bound live source. A create of a
  // fresh path needs no readVersion; only the default pairing should forbid it.
  const source = (method, input) => request(first, '/sources/' + method, { coordinatorHostId: 'ci-coordinator', ...input });
  const threadId = 'ci-thread', branchId = 'main', runId = 'ci-run', epoch = 1;
  const prepared = await positive(await source('prepare', { input: { runtime: 'agent', threadId, branchId, key: randomUUID(),
    resourceOwner: { kind: 'managed_host', hostId: identity.hostId, connectionId: name, endpointIdentity: first },
    workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] } }));
  assert(prepared.source.tools.includes('file_read'));
  assert(!prepared.source.tools.includes('file_write'));
  const { authorityId, resourceEpoch } = await positive(await source('bind', { source: prepared.source,
    scope: { kind: 'run', threadId, runId, epoch }, purpose: 'source', retention: 'run' }));
  const forbiddenName = 'denied-create.txt';
  const denied = await source('execute', { authorityId, resourceEpoch, call: { runId,
    origin: { kind: 'model_step', request_id: 'ci-request' }, operationId: 'ci-request:tool:create', callId: 'create',
    name: 'file_write', schemaVersion: '2', arguments: { path: forbiddenName, mode: 'create', content: 'unexpected creation' } },
    journal: { executionId: 'ci-execution', threadId, branchId, runId, entryId: 'ci-entry', epoch } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'source_authority_denied');
  await positive(await source('release', { authorityId, resourceEpoch, mode: 'retire' }));
  const checkWorkspace = async origin => {
    assert.equal((await read(origin)).revision, original.revision);
    assert.equal(docker(['exec', name, 'cat', `${workspace}/status.txt`], true), original.content);
    docker(['exec', name, 'test', '!', '-e', `${workspace}/${forbiddenName}`]);
  };
  await checkWorkspace(first);

  docker(['stop', '--timeout', '15', name]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name], true).trim(), '0');
  docker(['rm', name]);
  const second = await start();
  assert.equal((await positive(await request(second, '/identity'))).hostId, identity.hostId);
  assert.equal((await positive(await request(second, '/documents/workspace/resolve', { path: workspace }))).workspaceId, registration.workspaceId);
  await checkWorkspace(second);
  docker(['exec', name, 'sh', '-ec', checkAbsent]);
  docker(['stop', '--timeout', '15', name]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name], true).trim(), '0');
  console.log('Verified resource-only startup, original identity, paired access, denial and graceful restart');
} finally {
  for (const args of [['rm', '--force', name], ['volume', 'rm', name], ['volume', 'rm', workspaceName], ['volume', 'rm', privateName]]) {
    try { execFileSync('docker', args, { stdio: 'ignore', timeout: 30_000 }); } catch { /* an early failure may leave no fixture */ }
  }
}
