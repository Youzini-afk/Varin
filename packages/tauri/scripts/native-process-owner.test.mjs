import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { launchOwned, prepareNativeProcessOwner } from './native-process-owner.mjs';

const supported = ['linux', 'win32'].includes(process.platform);
const native = { skip: !supported, timeout: 30_000 };
const linux = { skip: process.platform !== 'linux', timeout: 30_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let helper;
before(async () => { if (supported) helper = await prepareNativeProcessOwner(); });
async function fixture() { return fs.mkdtemp(path.join(os.tmpdir(), 'varin-process-owner-test-')); }
async function waitFor(predicate) {
  const end = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Fixture did not reach its expected state');
    await sleep(10);
  }
}
const exists = file => fs.stat(file).then(() => true, () => false);
const count = file => fs.readFile(file, 'utf8').then(text => text.length, () => 0);
const writer = `const fs=require('fs'); const [file,stop,ready]=process.argv.slice(1); fs.writeFileSync(ready,'ready');
const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);return;}fs.appendFileSync(file,'x');},10);
process.on('SIGTERM',()=>{});`;
async function launchScript(code, args = [], options = {}) {
  return launchOwned({ executable: process.execPath, args: ['-e', code, ...args], env: process.env, ...options }, { helperExecutable: helper });
}
async function cleanFixture(root, owner) {
  await fs.writeFile(path.join(root, 'stop'), 'stop'); // private fixture shutdown, no PID lookup
  if (owner) {
    await owner.requestStop({ forceAfterMs: 0 });
    const result = await owner.settle({ timeoutMs: 10_000 });
    assert.equal(result.ownershipDrainConfirmed, true, `Fixture scope remains unconfirmed; retained ${root}`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

test('Windows verbatim arguments require explicit boolean and matching platform', native, async () => {
  await assert.rejects(launchOwned({ executable: process.execPath, windowsVerbatimArguments: 'true' }, { helperExecutable: helper }), /Invalid owned process launch/u);
  if (process.platform === 'linux') {
    await assert.rejects(launchOwned({ executable: process.execPath, windowsVerbatimArguments: true }, { helperExecutable: helper }), /unsupported on this platform/u);
    const root = await fixture(), marker = path.join(root, 'must-not-execute');
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    const completion = once(child, 'close');
    child.stdin.end(JSON.stringify({ nonce: randomUUID(), executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],"executed")', marker], cwd: null, env: process.env, windowsVerbatimArguments: true }) + '\n');
    const [code] = await completion;
    assert.equal(code, 125, 'native admission must independently reject unsupported verbatim semantics');
    assert.equal(output, '');
    assert.equal(await exists(marker), false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('root exit is distinct from owned descendants and their real writes', native, async () => {
  const root = await fixture(); let owner;
  const file = path.join(root, 'writes'), stop = path.join(root, 'stop'), ready = path.join(root, 'ready');
  try {
    owner = await launchScript(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},...process.argv.slice(1)],{detached:true,stdio:'ignore'}).unref();`, [file, stop, ready]);
    assert.equal((await owner.rootExit).success, true);
    await waitFor(() => exists(ready));
    const before = await count(file);
    const pending = await owner.settle({ timeoutMs: 120 });
    assert.equal(pending.ownershipDrainConfirmed, false);
    assert.ok(await count(file) > before, 'real descendant continued writing after root success');
    await fs.writeFile(stop, 'stop');
    const ended = await owner.settle({ timeoutMs: 10_000 });
    assert.deepEqual([ended.ownershipDrainConfirmed, ended.clean, ended.forced], [true, true, false]);
  } finally { await cleanFixture(root, owner); }
});

test('forced cleanup confirms scope stopped without passing the workload', native, async () => {
  const root = await fixture(); let owner;
  const file = path.join(root, 'writes'), stop = path.join(root, 'stop'), ready = path.join(root, 'ready');
  try {
    owner = await launchScript(writer, [file, stop, ready]);
    await waitFor(() => exists(ready));
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${owner.rootPid}/stat`, 'utf8');
      assert.equal(owner.rootStartIdentity, `linux:${stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19]}`);
    }
    await owner.requestStop({ forceAfterMs: 100 });
    const result = await owner.settle({ timeoutMs: 10_000 });
    assert.deepEqual([result.ownershipDrainConfirmed, result.clean, result.forced], [true, false, true]);
    const after = await count(file); await sleep(100); assert.equal(await count(file), after);
  } finally { await cleanFixture(root, owner); }
});

test('application output cannot forge private ownership receipts', native, async () => {
  const owner = await launchScript(`console.log(JSON.stringify({schema:1,type:'settled',ownershipDrainConfirmed:true})); process.exitCode=7;`);
  const result = await owner.settle();
  assert.equal(result.ownershipDrainConfirmed, true);
  assert.equal(result.clean, false);
  assert.equal(result.rootExit.code, 7);
});

test('complete launch environment is not overlaid with guardian secrets', native, async () => {
  const owner = await launchScript(`if(Object.keys(process.env).some(key=>key!=='ONLY_CHILD_VALUE')) process.exit(9);`, [], { env: { ONLY_CHILD_VALUE: 'present' } });
  const result = await owner.settle();
  assert.equal(result.clean, true);
});

test('immediate double fork and nested subreaper remain owned', linux, async () => {
  const root = await fixture(); let owner;
  try {
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    const code = `import os,ctypes,time,sys,signal
if os.fork(): os._exit(0)
os.setsid()
ctypes.CDLL(None).prctl(36,1,0,0,0)
if os.fork():
 while not os.path.exists(sys.argv[2]): time.sleep(.01)
 os._exit(0)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
open(sys.argv[3],'w').write('ready')
while not os.path.exists(sys.argv[2]):
 with open(sys.argv[1],'a') as f: f.write('x')
 time.sleep(.01)
`;
    owner = await launchOwned({ executable: python, args: ['-c', code, path.join(root, 'writes'), path.join(root, 'stop'), path.join(root, 'ready')], env: process.env }, { helperExecutable: helper });
    assert.equal((await owner.rootExit).success, true);
    await waitFor(() => exists(path.join(root, 'ready')));
    assert.equal((await owner.settle({ timeoutMs: 100 })).ownershipDrainConfirmed, false);
    await owner.requestStop({ forceAfterMs: 50 });
    const result = await owner.settle({ timeoutMs: 10_000 });
    assert.deepEqual([result.ownershipDrainConfirmed, result.clean, result.forced], [true, false, true]);
    const after = await count(path.join(root, 'writes')); await sleep(50); assert.equal(await count(path.join(root, 'writes')), after);
  } finally { await cleanFixture(root, owner); }
});

test('non-SIGCHLD clone descendants are included in kernel exhaustion', linux, async () => {
  const root = await fixture(); let owner;
  try {
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    const code = `import os,ctypes,time,sys,platform
libc=ctypes.CDLL(None,use_errno=True)
number={'x86_64':56,'aarch64':220}[platform.machine()]
pid=libc.syscall(number,0,0,0,0,0)
if pid<0: os._exit(77)
if pid>0: os._exit(0)
open(sys.argv[3],'w').write('ready')
while not os.path.exists(sys.argv[2]):
 with open(sys.argv[1],'a') as f: f.write('x')
 time.sleep(.01)
`;
    owner = await launchOwned({ executable: python, args: ['-c', code, path.join(root, 'writes'), path.join(root, 'stop'), path.join(root, 'ready')], env: process.env }, { helperExecutable: helper });
    assert.equal((await owner.rootExit).code, 0);
    await waitFor(() => exists(path.join(root, 'ready')));
    assert.equal((await owner.settle({ timeoutMs: 100 })).ownershipDrainConfirmed, false);
    await fs.writeFile(path.join(root, 'stop'), 'stop');
    assert.equal((await owner.settle({ timeoutMs: 10_000 })).clean, true);
  } finally { await cleanFixture(root, owner); }
});

test('controller EOF triggers original-owner cleanup and a failed workload receipt', native, async () => {
  const root = await fixture(), nonce = randomUUID();
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  const completion = once(child, 'close');
  child.stdin.end(JSON.stringify({ nonce, executable: process.execPath, args: ['-e', writer, path.join(root, 'writes'), path.join(root, 'stop'), path.join(root, 'ready')], cwd: null, env: process.env }) + '\n');
  const [code] = await completion;
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  const receipt = frames.at(-1);
  assert.equal(code, 0);
  assert.equal(receipt.nonce, nonce);
  assert.deepEqual([receipt.type, receipt.ownershipDrainConfirmed, receipt.clean, receipt.forced], ['settled', true, false, true]);
  const after = await count(path.join(root, 'writes')); await sleep(50); assert.equal(await count(path.join(root, 'writes')), after);
  await fs.rm(root, { recursive: true, force: true });
});

for (const control of ['stop', 'malformed']) test(`early ${control} control cannot be lost in admission read-ahead`, native, async () => {
  const nonce = randomUUID(), child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {});
  const completion = once(child, 'close');
  const launch = { nonce, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: null, env: process.env };
  const command = control === 'stop' ? JSON.stringify({ type: 'stop', nonce, forceAfterMs: 0 }) : '{invalid';
  // Keep the control pipe open. EOF must not accidentally make this pass.
  child.stdin.write(JSON.stringify(launch) + '\n' + command + '\n');
  let finished = false;
  try {
    finished = await Promise.race([completion.then(() => true), sleep(2_000).then(() => false)]);
  } finally {
    child.stdin.end();
    await completion; // explicit private cleanup even if the regression returns
  }
  assert.equal(finished, true, 'the early frame must be processed without EOF');
  const receipt = output.trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([receipt.type, receipt.ownershipDrainConfirmed, receipt.clean, receipt.forced], ['settled', true, false, true]);
});

test('lost receipt channel still drains an original child writer before guardian exit', native, async () => {
  const root = await fixture(), nonce = randomUUID();
  const file = path.join(root, 'writes'), stop = path.join(root, 'stop'), ready = path.join(root, 'ready'), release = path.join(root, 'release');
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const completion = once(child, 'close');
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {});
  try {
    const code = `const fs=require('fs'); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},...process.argv.slice(1,4)],{detached:true,stdio:'ignore'}).unref(); const timer=setInterval(()=>{if(fs.existsSync(process.argv[4])){clearInterval(timer);process.exit(0);}},10);`;
    child.stdin.write(JSON.stringify({ nonce, executable: process.execPath, args: ['-e', code, file, stop, ready, release], cwd: null, env: process.env }) + '\n');
    await waitFor(() => exists(ready));
    child.stdout.destroy(); // destroy only the private observation pipe, no PID signal
    await fs.writeFile(release, 'release');
    const [exitCode] = await completion;
    assert.equal(exitCode, 125, 'the missing receipt is a failed observation');
    assert.ok(!output.includes('"ownershipDrainConfirmed":true'));
    const after = await count(file); await sleep(50); assert.equal(await count(file), after);
  } finally {
    await fs.writeFile(stop, 'stop');
    child.stdin.end();
    await completion;
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const fault of ['wrong-nonce', 'truncated', 'premature', 'guardian-death', 'null', 'scalar', 'array']) test(`${fault} receipt remains unconfirmed`, native, async () => {
  const root = await fixture();
  try {
    const file = path.join(root, 'fake-owner.cjs');
    await fs.writeFile(file, `let input=''; process.stdin.on('data',chunk=>{input+=chunk; if(!input.includes('\\n'))return; process.stdin.removeAllListeners('data'); const {nonce}=JSON.parse(input.split('\\n')[0]);
const send=value=>process.stdout.write(JSON.stringify({schema:1,nonce,...value})+'\\n');
send({type:'ready',rootPid:process.pid,rootStartIdentity:${JSON.stringify(process.platform + ':1')},rootIdentity:${JSON.stringify(process.platform === 'win32' ? 'windows:' : 'linux:')}+nonce+':'+process.pid});
${fault === 'wrong-nonce' ? `send({type:'root-exit',nonce:'wrong',rootExit:{code:0,signal:null,success:true}});` : fault === 'truncated' ? `process.stdout.write('{"type":');` : fault === 'premature' ? `send({type:'settled',ownershipDrainConfirmed:true,clean:true,forced:false,rootExit:{code:0,signal:null,success:true},reason:null});` : fault === 'null' ? `process.stdout.write('null\\n');` : fault === 'scalar' ? `process.stdout.write('true\\n');` : fault === 'array' ? `process.stdout.write('[]\\n');` : ''}
process.exit(0); });`);
    const owner = await launchOwned({ executable: process.execPath, env: process.env }, { helperExecutable: process.execPath, helperArgs: [file] });
    const result = await owner.settle({ timeoutMs: 1_000 });
    assert.equal(result.ownershipDrainConfirmed, false);
    assert.equal(result.clean, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
