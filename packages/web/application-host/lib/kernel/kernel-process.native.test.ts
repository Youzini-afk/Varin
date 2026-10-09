import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.test-helper.js";
import { createShellSupervisor } from "../harness/shell-supervisor.js";
import { createOutputStore } from "../harness/output-store.js";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TransportFixture } from "./tests/transport-fixture.js";
import { createKernelProcessService } from "./process-service.js";
import fs from "node:fs/promises";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, it as vitestIt } from "vitest";
import { createKernelClient, type KernelClient, type KernelScopedClient } from "./kernel-client.js";
import type { KernelMethodParams, KernelProcessSnapshot } from "./protocol.generated.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") throw new Error("Native process acceptance requires the release kernel");
const it = vitestIt.skipIf(!available);
const clients: KernelClient[] = [];
const roots: string[] = [];
const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    // A crashed kernel cannot confirm the old handle in memory. Reopen the
    // actual catalog and wait for OS/guardian evidence before deleting fixtures.
    const cleanup = createKernelClient({ hostId: 'process-test', storageRoot: path.join(root, 'storage'), kernelPath, buildVersion, allowCargoDevRunner: false });
    try {
      await cleanup.start();
      const maintenance = cleanup.scoped(await cleanup.issueGrant({ grantId: 'fixture-cleanup', owningWorkspace: 'ws', executionWorkspace: 'ws', pathScopes: [''], capabilities: ['storage.read','storage.write','process','process.maintenance'] }));
      const registered = await maintenance.fileRootRegister({ workspaceId: 'ws', executionWorkspaceId: 'ws', canonicalRoot: path.join(root,'workspace') });
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { processes } = await maintenance.processList({ workspaceId: 'ws', rootId: String(registered.rootId) });
        if (processes.every((process) => !process.writerActive)) break;
        if (Date.now() > deadline) throw new Error('Test process tree is still unconfirmed; retaining fixture '+root);
        await pause();
      }
    } finally { await cleanup.close(); }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-native-process-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "child"), { recursive: true });
  const storageRoot = path.join(root, "storage");
  let kernelChild: ChildProcessWithoutNullStreams | undefined;
  const probe = new TransportFixture();
  const host = createKernelClient({ hostId: "process-test", storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false, env, transportFactory: probe.create,
    spawnProcess: ((command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => {
      const child = nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams; kernelChild = child; return child;
    }) as typeof nodeSpawn,
  });
  clients.push(host);
  await host.start();
  const scoped = async (id: string, extra: string[] = []) => host.scoped(await host.issueGrant({
    grantId: id, owningWorkspace: "ws", executionWorkspace: "ws", pathScopes: [""],
    capabilities: ["storage.read", "storage.write", "process", ...extra],
  }));
  const client = await scoped("process-owner", ["process.maintenance"]);
  const registered = await client.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: workspace });
  const address = { workspaceId: "ws", rootId: String(registered.rootId) };
  const spawn = (processId: string, script: string, mode = "pipe"): KernelMethodParams["process.spawn"] => ({
    ...address, processId, cwd: "child", command: process.execPath, args: ["-e", script], mode,
    env: Object.entries({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }).flatMap(([name, value]) => value === undefined ? [] : [{ name, value }]),
    cols: 90, rows: 30,
  });
  return { root, workspace, storageRoot, host, client, scoped, address, spawn, probe, kernelChild: kernelChild! };
}
async function waitFor(client: KernelScopedClient, processId: string, predicate: (snapshot: KernelProcessSnapshot) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snapshot = await client.processInspect({ workspaceId: "ws", processId });
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`Native process did not reach expected state: ${JSON.stringify(snapshot)}`);
    await pause();
  }
}
async function drain(client: KernelScopedClient, processId: string, start = 0) {
  let cursor = start;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await client.processRead({ workspaceId: "ws", processId, cursor });
    for (const chunk of result.chunks) {
      assert.equal(chunk.offset, cursor);
      const bytes = Buffer.from(chunk.bytesBase64, "base64");
      (chunk.channel === "stdout" ? stdout : stderr).push(bytes);
      cursor += bytes.length;
    }
    assert.equal(cursor, result.nextCursor);
    if (result.outputError) throw new Error(result.outputError);
    if (!result.process.writerActive && result.outputComplete && cursor === result.endCursor) {
      return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), process: result.process, cursor };
    }
    if (Date.now() > deadline) throw new Error(`Process did not exit: ${JSON.stringify(result.process)}`);
    await pause();
  }
}

it("native process pipes preserve binary stdout/stderr, bounded cursors and the actual exit code", async () => {
  const f = await fixture();
  const params = f.spawn("binary", "process.stdout.write(Buffer.from([0,255,128,65,10]));process.stderr.write('error-stream');process.exitCode=7");
  await f.client.processSpawn(params);
  const result = await drain(f.client, params.processId);
  assert.deepEqual(result.stdout, Buffer.from([0,255,128,65,10]));
  assert.equal(result.stderr.toString(), "error-stream");
  assert.equal(result.process.exitCode, 7);
  assert.equal(result.process.status, "exited");
  assert.equal(result.process.writerActive, false);
  const retry = await f.client.processSpawn(params);
  assert.equal(retry.status, "exited");
  await assert.rejects(f.client.processSpawn({ ...params, args: ["-e", "process.exit(0)"] }), /reused|parameters/);
  await f.client.processRelease({ workspaceId: "ws", processId: params.processId });
  assert.equal((await f.client.processSpawn(params)).status, "released");
}, 30_000);

it("native process stdin has exact sequence receipts and duplicate writes never execute twice", async () => {
  const f = await fixture();
  const params = f.spawn("stdin", "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(b)))");
  await f.client.processSpawn(params);
  await waitFor(f.client, params.processId, (p) => p.pid !== null);
  const write = { workspaceId: "ws", processId: params.processId, sequence: 0, bytesBase64: Buffer.from("only-once").toString("base64"), eof: true };
  await f.client.processWrite(write);
  await f.client.processWrite(write);
  const result = await drain(f.client, params.processId);
  assert.equal(result.stdout.toString(), "only-once");
  assert.equal(result.process.exitCode, 0, JSON.stringify(result.process));
}, 30_000);

it("native PTY is a real terminal with its requested dimensions and resize input", async () => {
  const f = await fixture();
  for (let iteration = 0; iteration < 12; iteration++) {
  const params = f.spawn(`pty-${iteration}`, "console.log('TTY',process.stdin.isTTY,process.stdout.isTTY,process.stdout.columns,process.stdout.rows);process.stdin.resume();process.stdin.on('data',()=>{console.log('SIZE',...new (require('tty').WriteStream)(1).getWindowSize());process.exit(0)})", "pty");
  await f.client.processSpawn(params);
  await waitFor(f.client, params.processId, (p) => p.pid !== null);
  // Read the startup observation before resizing; an OS handle, not spawn time, is the evidence.
  let cursor = 0, initial = "";
  for (let n = 0; n < 100 && !initial.includes("TTY"); n += 1) {
    const read = await f.client.processRead({ workspaceId: "ws", processId: params.processId, cursor });
    initial += read.chunks.map((chunk) => Buffer.from(chunk.bytesBase64, "base64").toString()).join("");
    cursor = read.nextCursor;
    await pause();
  }
  assert.match(stripVTControlCharacters(initial), /TTY true true 90 30/);
  await f.client.processResize({ workspaceId: "ws", processId: params.processId, cols: 111, rows: 41 });
  await pause(100);
  await f.client.processWrite({ workspaceId: "ws", processId: params.processId, sequence: 0, bytesBase64: Buffer.from("go\r").toString("base64") });
  const result = await drain(f.client, params.processId, cursor);
  assert.match(stripVTControlCharacters(result.stdout.toString()), /SIZE 111 41/);
  assert.equal(result.process.exitCode, 0, JSON.stringify(result.process));
  }
}, 30_000);

it("a native process writer prevents directory removal and release until its process tree exits", async () => {
  const f = await fixture();
  const params = f.spawn("writer", "setInterval(()=>{},1000)");
  await f.client.processSpawn(params);
  await waitFor(f.client, params.processId, (p) => p.pid !== null);
  await assert.rejects(f.client.processRelease({ workspaceId: "ws", processId: params.processId }), /in use|unconfirmed/);
  await assert.rejects(f.client.fileRemove({ ...f.address, operationId: "blocked-remove", path: "child", recursive: true, force: true }), /writer|exit/);
  assert.ok((await fs.stat(path.join(f.workspace, "child"))).isDirectory());
  await f.client.processKill({ workspaceId: "ws", processId: params.processId, force: true });
  const result = await drain(f.client, params.processId);
  assert.equal(result.process.writerActive, false);
  await f.client.fileRemove({ ...f.address, operationId: "after-exit-remove", path: "child", recursive: true, force: true });
}, 30_000);

it("native process handles reject another actor and a cwd escaping its admitted root", async () => {
  const f = await fixture();
  const params = f.spawn("actor", "setInterval(()=>{},1000)");
  await f.client.processSpawn(params);
  const other = await f.scoped("other");
  await assert.rejects(other.processRead({ workspaceId: "ws", processId: params.processId, cursor: 0 }), /actor|workspace/);
  await assert.rejects(other.processKill({ workspaceId: "ws", processId: params.processId }), /actor|workspace/);
  await assert.rejects(f.client.processSpawn({ ...params, processId: "escape", cwd: "../" }), /path|root|parent/i);
  await f.client.processKill({ workspaceId: "ws", processId: params.processId, force: true });
  await drain(f.client, params.processId);
}, 30_000);


it("native process kill refusal keeps its identity and directory writer active", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_PROCESS_PHASE: "kill" });
  await f.client.processSpawn(f.spawn("refused", "setInterval(()=>{},1000)"));
  await waitFor(f.client, "refused", (s) => s.pid !== null);
  await assert.rejects(f.client.processKill({ workspaceId: "ws", processId: "refused", force: true }), /injected/);
  assert.equal((await f.client.processInspect({ workspaceId: "ws", processId: "refused" })).writerActive, true);
  await assert.rejects(f.client.fileRemove({ ...f.address, operationId: "refused-remove", path: "child", recursive: true, force: true }), /writer|exit/);
}, 30_000);

it("raw output above the native buffer bound reaches real exit before any reader and remains byte-exact", async () => {
  const f = await fixture();
  await f.client.processSpawn(f.spawn("large", "process.stdout.write(Buffer.alloc(16*1024*1024,173));process.stderr.write('done');process.exitCode=7"));
  await waitFor(f.client, "large", (s) => s.pid !== null);
  await pause(200);
  assert.equal((await f.client.health()).integrity, "ok");
  const terminal = await waitFor(f.client, "large", (s) => !s.writerActive);
  assert.equal(terminal.status, "exited");
  assert.equal(terminal.exitCode, 7);
  const result = await drain(f.client, "large");
  assert.deepEqual(result.stdout, Buffer.alloc(16*1024*1024,173));
  assert.equal(result.stderr.toString(), "done");
}, 30_000);

it("the Host stream adapter uses native push delivery and closes after complete binary I/O", async () => {
  const f = await fixture();
  const methods: string[] = [];
  f.probe.onSend = envelope => { if (typeof envelope.method === 'string') methods.push(envelope.method); };
  const service = createKernelProcessService({ client: f.host, resolveIdentity: async () => ({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace }) });
  try {
    const child = await service.spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: path.join(f.workspace, "child"), env: process.env, stdio: "pipe" });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
    child.stderr.resume();
    let closed = false;
    child.once("close", () => { closed = true; });
    const bytes = Buffer.alloc(256*1024, 201);
    child.stdin.end(bytes);
    await child.completion;
    assert.equal(closed, true);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(child.exitCode, 0);
    assert.ok(methods.includes("process.subscribe"));
    assert.equal(methods.includes("process.read"), false, "Host output delivery must not poll process.read");
    assert.equal((await service.list(f.workspace))[0]?.writerActive, false);
  } finally { await service.dispose(); }
}, 30_000);

it("a failed native spawn rejects the Host launch without leaving a live writer", async () => {
  const f = await fixture();
  const service = createKernelProcessService({ client: f.host, resolveIdentity: async () => ({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace }) });
  try {
    await assert.rejects(service.spawn(path.join(f.root, "missing-executable"), [], { cwd: f.workspace }), /spawn|start|file|found/i);
    for (let n=0; n<100 && (await service.list(f.workspace)).some((p) => p.writerActive); n++) await pause();
    assert.ok((await service.list(f.workspace)).every((p) => !p.writerActive));
  } finally { await service.dispose(); }
}, 30_000);

it("kernel death invalidates the Host handle without manufacturing an exit event", async () => {
  const f = await fixture();
  const service = createKernelProcessService({ client: f.host, resolveIdentity: async () => ({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace }) });
  try {
    const child = await service.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: path.join(f.workspace, "child") });
    child.stdout.resume(); child.stderr.resume();
    let exited = false;
    child.once("exit", () => { exited = true; });
    f.kernelChild.kill("SIGKILL");
    await assert.rejects(child.completion, /kernel|epoch|Rust|pipe/i);
    assert.equal(exited, false);
    assert.equal(child.snapshot.status, "unknown");
    assert.equal(child.snapshot.writerActive, true);
  } finally { await service.dispose(); }
}, 30_000);


it("a held filesystem lease prevents a new native writer entering that directory", async () => {
  const f = await fixture();
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "capture-lease", resources: [{ path: "child", scope: "subtree" }] });
  await assert.rejects(f.client.processSpawn(f.spawn("leased", "process.exit(0)")), /busy|lease/i);
  await f.client.fileLeaseRelease({ ...f.address, leaseId: "capture-lease" });
  await f.client.processSpawn(f.spawn("leased", "process.exit(0)"));
  assert.equal((await drain(f.client, "leased")).process.exitCode, 0);
}, 30_000);

it("revoking a process actor requests native stop and leaves exit confirmation to maintenance", async () => {
  const f = await fixture();
  await f.client.processSpawn(f.spawn("revoked", "setInterval(()=>{},1000)"));
  await waitFor(f.client, "revoked", (s) => s.pid !== null);
  const result = await f.host.revokeGrant("process-owner");
  assert.equal(result.revoked, true);
  await assert.rejects(f.client.processInspect({ workspaceId: "ws", processId: "revoked" }), /revoked|grant/i);
  const maintenance = await f.scoped("revoke-maintenance", ["process.maintenance"]);
  assert.equal((await waitFor(maintenance, "revoked", (s) => !s.writerActive)).status, "exited");
}, 30_000);

it("natural command exit drains descendants before releasing its directory writer", async () => {
  const f = await fixture();
  const marker = path.join(f.workspace, "child", "late-write.txt");
  // Linux subreaper and Windows Job also retain detached descendants. Other
  // Unix backends verify the managed process session, without a sandbox claim.
  const detached = process.platform === "linux" || process.platform === "win32";
  const child = "setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(marker)+",'unexpected'),1000);setInterval(()=>{},1000)";
  await f.client.processSpawn(f.spawn("descendants", "const c=require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{detached:"+detached+",stdio:'ignore'});c.unref();console.log(c.pid)"));
  const result = await drain(f.client, "descendants");
  assert.equal(result.process.exitCode, 0, JSON.stringify(result.process));
  await pause(1100);
  assert.equal(await fs.stat(marker).then(()=>true,()=>false), false);
  await f.client.fileRemove({ ...f.address, operationId: "remove-drained", path: "child", recursive: true, force: true });
}, 30_000);

it("kernel restart reconciles an interrupted native tree without replaying its command", async () => {
  const f = await fixture();
  const counter=path.join(f.workspace,"child","executions.txt");
  const params=f.spawn("restart", "require('node:fs').appendFileSync("+JSON.stringify(counter)+",'once\\n');setInterval(()=>{},1000)");
  await f.client.processSpawn(params);
  for(let i=0;i<500;i++){if(await fs.stat(counter).then(()=>true,()=>false))break;await pause();}
  assert.equal(await fs.readFile(counter,"utf8"),"once\n");
  const exited=new Promise<void>(resolve=>f.kernelChild.once("exit",()=>resolve()));
  f.kernelChild.kill("SIGKILL");await exited;
  const reopened=createKernelClient({hostId:"process-test",storageRoot:f.storageRoot,kernelPath,buildVersion,allowCargoDevRunner:false});clients.push(reopened);
  await reopened.start();
  const maintenance=reopened.scoped(await reopened.issueGrant({grantId:"restart-maintenance",owningWorkspace:"ws",executionWorkspace:"ws",pathScopes:[""],capabilities:["storage.read","storage.write","process","process.maintenance"]}));
  const receipt=await waitFor(maintenance,"restart",r=>!r.writerActive);
  assert.equal(receipt.outputAvailable,true);
  assert.equal(await fs.readFile(counter,"utf8"),"once\n");
  await maintenance.processRelease({workspaceId:"ws",processId:"restart"});
  assert.equal((await maintenance.processInspect({workspaceId:"ws",processId:"restart"})).status,"released");
},30_000);


it("native terminal and shell consumers expose authority loss without releasing writers or inventing success", async () => {
  const f=await fixture();
  const service=createKernelProcessService({client:f.host,resolveIdentity:async()=>({workspaceId:"ws",executionWorkspaceId:"ws",canonicalRoot:f.workspace})});
  const terminal=createIsolatedTerminalSessionApi({loadPtyProvider:async()=>service.ptyProvider});
  const store=createOutputStore();
  const handles: Awaited<ReturnType<typeof terminal.createTerminalSession>>[]=[];
  let completed=0;let released=0;
  const shell=createShellSupervisor({
    sessionId:"lost-native-shell",cwd:path.join(f.workspace,"child"),outputStore:store,
    interpreter:process.platform==="win32"
      ?{kind:"powershell",command:"powershell.exe",args:["-NoLogo","-NoProfile","-NoExit"],env:{}}
      :{kind:"bash",command:"bash",args:["-l"],env:{}},
    createTerminalSession:async(input)=>{const h=await terminal.createTerminalSession(input);handles.push(h);return h;},
    registerWriter:async()=>({close:async()=>{released++;}}),
    commandLifecycle:{completed:()=>{completed++;}},
  });
  try {
    const command=process.platform==="win32"?"Start-Sleep -Seconds 60":"sleep 60";
    const background=await shell.exec(command,{waitMs:50});
    assert.ok(background.kind==="background"||background.kind==="preparing");
    if(background.kind!=="background"&&background.kind!=="preparing")throw new Error(JSON.stringify(background));
    const executionId=background.executionId!;
    let shellId=background.kind==="background"?background.id:undefined;
    const deadline=Date.now()+15_000;
    while(!shellId){
      const state=await shell.read(executionId);
      shellId=state.shellId;
      if(!shellId&&Date.now()>deadline)throw new Error("Native shell did not finish preparation");
      if(!shellId)await pause();
    }
    const handle=handles[0]!;
    let exit=false;handle.onExit(()=>{exit=true;});
    const waiting=assert.rejects(handle.waitForExit(),/unavailable|unconfirmed/i);
    f.kernelChild.kill("SIGKILL");
    await waiting;
    assert.equal(terminal.inspectSession(handle.id)?.status,"error");
    await assert.rejects(shell.read(shellId),/unavailable|unconfirmed/i);
    assert.equal(exit,false);assert.equal(completed,0);assert.equal(released,0);
    assert.equal(shell.hasActiveCommandAt(path.join(f.workspace,"child")),true);
    await assert.rejects(shell.dispose(),/kernel|epoch|unconfirmed|pipe/i);
    await assert.rejects(terminal.shutdown(),/unconfirmed/i);
    assert.equal(terminal.inspectSession(handle.id)?.status,"error");
  } finally {
    // Loss is the expected test outcome, not a fabricated successful close.
    await service.dispose().catch(()=>undefined);
    await terminal.shutdown().catch(()=>undefined);
    await shell.dispose().catch(()=>undefined);
    store.dispose();
  }
},30_000);


it("abrupt Host death closes its private kernel pipe and drains the native process tree", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"varin-native-process-host-loss-"));roots.push(root);
  const workspace=path.join(root,"workspace");await fs.mkdir(workspace,{recursive:true});
  const storageRoot=path.join(root,"storage");
  const source = [
    "import { createKernelClient } from "+JSON.stringify(pathToFileURL(path.join(repositoryRoot,"packages/web/application-host/lib/kernel/kernel-client.ts")).href)+";",
    "const host=createKernelClient("+JSON.stringify({hostId:"process-test",storageRoot,kernelPath,buildVersion,allowCargoDevRunner:false})+");",
    "await host.start();",
    "const client=host.scoped(await host.issueGrant({grantId:'owner',owningWorkspace:'ws',executionWorkspace:'ws',pathScopes:[''],capabilities:['storage.read','storage.write','process','process.maintenance']}));",
    "const root=await client.fileRootRegister({workspaceId:'ws',executionWorkspaceId:'ws',canonicalRoot:"+JSON.stringify(workspace)+"});",
    "await client.processSpawn({workspaceId:'ws',rootId:root.rootId,processId:'host-loss',cwd:'',mode:'pipe',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:Object.entries(process.env).filter(([k,v])=>v!==undefined&&k!=='NODE_CHANNEL_FD').map(([name,value])=>({name,value}))});",
    "for(;;){const p=await client.processInspect({workspaceId:'ws',processId:'host-loss'});if(p.pid){console.log('HOST_READY');break;}await new Promise(r=>setTimeout(r,10));}",
    "setInterval(()=>{},1000);",
  ].join("\n");
  const host=nodeSpawn(process.execPath,["--import","tsx","--input-type=module","-e",source],{cwd:repositoryRoot,stdio:["ignore","pipe","pipe"],windowsHide:true});
  let stderr="";host.stderr.setEncoding("utf8");host.stderr.on("data",(text:string)=>{stderr+=text;});
  try {
    await new Promise<void>((resolve,reject)=>{
      let text="";const timeout=setTimeout(()=>reject(new Error("Host startup timed out: "+stderr)),15000);
      host.stdout.setEncoding("utf8");host.stdout.on("data",(data:string)=>{text+=data;if(text.includes("HOST_READY")){clearTimeout(timeout);resolve();}});
      host.once("error",error=>{clearTimeout(timeout);reject(error);});
      host.once("exit",code=>{clearTimeout(timeout);if(!text.includes("HOST_READY"))reject(new Error("Host exited "+code+": "+stderr));});
    });
    const closed=new Promise<void>(resolve=>host.once("exit",()=>resolve()));
    host.kill("SIGKILL");await closed;
    // Reacquiring Storage proves the orphan kernel released its lock. Failure
    // retries only storage admission, never the interrupted user's command.
    let reopened:KernelClient|undefined;
    for(let i=0;i<100;i++){
      const candidate=createKernelClient({hostId:"process-test",storageRoot,kernelPath,buildVersion,allowCargoDevRunner:false});
      try {await candidate.start();reopened=candidate;clients.push(candidate);break;}
      catch(error){await candidate.close().catch(()=>undefined);if(i===99)throw error;await pause(50);}
    }
    assert.ok(reopened);
    const maintenance=reopened.scoped(await reopened.issueGrant({grantId:"host-loss-maintenance",owningWorkspace:"ws",executionWorkspace:"ws",pathScopes:[""],capabilities:["storage.read","storage.write","process","process.maintenance"]}));
    const record=await waitFor(maintenance,"host-loss",value=>!value.writerActive);
    assert.ok(record.status==="exited"||record.status==="failed");
    assert.equal(record.outputAvailable,true);
  } finally {
    if(host.exitCode===null&&host.signalCode===null){const stopped=new Promise<void>(resolve=>host.once("exit",()=>resolve()));host.kill("SIGKILL");await stopped;}
  }
},30_000);


it("stdin control receipts progress behind unread output without duplicate input", async () => {
  const f = await fixture();
  const marker = path.join(f.workspace, "child", "output-written");
  const script = "const fs=require('node:fs');const b=Buffer.alloc(65536,91);for(let i=0;i<128;i++)fs.writeSync(1,b);fs.writeFileSync("+JSON.stringify(marker)+",'ready');let input=[];process.stdin.on('data',b=>input.push(b));process.stdin.on('end',()=>process.stderr.write(Buffer.concat(input)));";
  await f.client.processSpawn(f.spawn("unread-input", script));
  const deadline = Date.now() + 15_000;
  while (!(await fs.stat(marker).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error("Unread output blocked the child before stdin admission");
    await pause();
  }
  const first = { workspaceId: "ws", processId: "unread-input", sequence: 0, bytesBase64: Buffer.from("first-").toString("base64") };
  await f.client.processWrite(first);
  await f.client.processWrite(first);
  // Acceptance of the next sequence proves the previous control receipt was
  // delivered; no process.read call has consumed even one output byte.
  for (;;) {
    try {
      await f.client.processWrite({ ...first, sequence: 1, bytesBase64: Buffer.from("second").toString("base64"), eof: true });
      break;
    } catch (error) {
      if (!/awaiting its write receipt/.test(String(error)) || Date.now() > deadline) throw error;
      await pause();
    }
  }
  assert.equal((await waitFor(f.client, "unread-input", s => !s.writerActive)).exitCode, 0);
  const result = await drain(f.client, "unread-input");
  assert.deepEqual(result.stdout, Buffer.alloc(8*1024*1024,91));
  assert.equal(result.stderr.toString(), "first-second");
}, 30_000);

it("native termination confirms the real tree while its output remains unread", async () => {
  const f = await fixture();
  const marker = path.join(f.workspace, "child", "output-ready");
  await f.client.processSpawn(f.spawn("unread-kill", "const fs=require('node:fs');const b=Buffer.alloc(65536,47);for(let i=0;i<128;i++)fs.writeSync(1,b);fs.writeFileSync("+JSON.stringify(marker)+",'ready');setInterval(()=>{},1000)"));
  const deadline = Date.now() + 15_000;
  while (!(await fs.stat(marker).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error("Unread output blocked native termination fixture");
    await pause();
  }
  await f.client.processKill({ workspaceId: "ws", processId: "unread-kill", force: true });
  const terminal = await waitFor(f.client, "unread-kill", s => !s.writerActive);
  assert.equal(terminal.status, "exited");
  const result = await drain(f.client, "unread-kill");
  assert.deepEqual(result.stdout, Buffer.alloc(8*1024*1024,47));
  await f.client.fileRemove({ ...f.address, operationId: "unread-kill-reclaim", path: "child", recursive: true, force: true });
}, 30_000);

vitestIt.skipIf(!available || process.platform !== "linux")("a truncated guardian control frame terminates its own real child and persists the exit receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-guardian-truncation-"));
  const receiptPath = path.join(root, "receipt.json");
  const guardian = nodeSpawn(kernelPath, ["--process-worker"], { stdio: ["pipe", "pipe", "pipe"] });
  const frames: Array<Record<string, unknown>> = [];
  let pending = Buffer.alloc(0);
  guardian.stdout.on("data", (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
      const end = pending.readUInt32BE(0) + 4;
      frames.push(JSON.parse(pending.subarray(4, end).toString()) as Record<string, unknown>);
      pending = pending.subarray(end);
    }
  });
  guardian.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => { guardian.once("error", reject); guardian.once("close", () => resolve()); });
  const config = Buffer.from(JSON.stringify({ processId: "truncated-control", kernelEpoch: "test-epoch", receiptPath, jobName: "", cwd: root, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: [], mode: "pipe", cols: 80, rows: 24 }));
  const header = Buffer.alloc(4); header.writeUInt32BE(config.length);
  try {
    guardian.stdin.write(Buffer.concat([header, config]));
    const deadline = Date.now() + 10_000;
    while (!frames.some(value => value.type === "started")) {
      if (Date.now() > deadline || guardian.exitCode !== null) throw new Error("Guardian did not start its child");
      await pause();
    }
    guardian.stdin.end(Buffer.from([0, 0, 0, 20, 123]));
    while (guardian.exitCode === null && guardian.signalCode === null) {
      if (Date.now() > deadline) throw new Error("Truncated control frame left its child running");
      await pause();
    }
    await exited;
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
    assert.equal(receipt.processId, "truncated-control");
    assert.equal(receipt.kernelEpoch, "test-epoch");
    assert.equal(receipt.treeConfirmed, true);
    assert.equal(receipt.status, "exited");
    assert.ok(frames.some(frame => frame.type === "receipt"));
  } finally {
    if (guardian.exitCode === null && guardian.signalCode === null) {
      guardian.kill("SIGUSR2");
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("spooled output preserves partial-frame cursor replay and rejects acknowledged history", async () => {
  const f = await fixture();
  const expected = Buffer.from(Array.from({ length: 131_079 }, (_, index) => index % 251));
  await f.client.processSpawn(f.spawn("partial-cursor", "process.stdout.write(Buffer.from(Array.from({length:131079},(_,i)=>i%251)))"));
  await waitFor(f.client, "partial-cursor", s => !s.writerActive);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await f.client.processRead({ workspaceId: "ws", processId: "partial-cursor", cursor: 0, maxBytes: 1 });
    if (state.outputError) throw new Error(state.outputError);
    if (state.outputComplete) break;
    if (Date.now() > deadline) throw new Error("Process log did not reach complete output");
    await pause();
  }
  let cursor = 0;
  const bytes: Buffer[] = [];
  for (const maxBytes of [1, 7, 65_535, 13]) {
    const request = { workspaceId: "ws", processId: "partial-cursor", cursor, maxBytes };
    const read = await f.client.processRead(request);
    const replay = await f.client.processRead(request);
    assert.deepEqual(replay.chunks, read.chunks);
    for (const chunk of read.chunks) {
      assert.equal(chunk.offset, cursor);
      assert.equal(chunk.channel, "stdout");
      const part = Buffer.from(chunk.bytesBase64, "base64");
      bytes.push(part);
      cursor += part.length;
    }
    assert.equal(cursor, read.nextCursor);
    assert.equal(read.nextCursor - request.cursor, maxBytes);
  }
  await assert.rejects(f.client.processRead({ workspaceId: "ws", processId: "partial-cursor", cursor: 0 }), /outside retained bytes/);
  const rest = await drain(f.client, "partial-cursor", cursor);
  assert.deepEqual(Buffer.concat([...bytes, rest.stdout]), expected);
}, 30_000);

it("immediate stop after spawn admission retains a provable tree exit even before started observation", async () => {
  const f = await fixture();
  for (let index = 0; index < 12; index++) {
    const processId = `early-stop-${index}`;
    await f.client.processSpawn(f.spawn(processId, "setInterval(()=>{},1000)"));
    // Admission permits immediate cancellation. Waiting for pid here would hide
    // the guardian startup/signal-handler race this regression exercises.
    await f.client.processKill({ workspaceId: "ws", processId, force: true });
    const terminal = await waitFor(f.client, processId, snapshot => !snapshot.writerActive);
    assert.ok(terminal.status === "exited" || terminal.status === "failed");
    await f.client.processRelease({ workspaceId: "ws", processId });
    const files = outputFiles(f, processId);
    assert.equal(await fs.stat(files.spool).then(() => true, () => false), false);
    assert.equal(await fs.stat(files.marker).then(() => true, () => false), false);
  }
  await f.host.close();
  const retained = await fs.readdir(path.join(f.storageRoot, "process-receipts"));
  assert.equal(retained.some(name => name.endsWith(".output") || name.endsWith(".output.complete") || name.endsWith(".complete.tmp")), false);
}, 30_000);


it("unavailable output storage rejects admission without executing the command or retaining a writer", async () => {
  const f = await fixture();
  const processId = "unavailable-spool";
  const spool = path.join(f.storageRoot, "process-receipts", createHash("sha256").update(processId).digest("hex") + ".output");
  // A real filesystem failure at the private output destination, without
  // filling the machine's disk or injecting faults into unrelated processes.
  await fs.mkdir(spool, { recursive: true });
  const marker = path.join(f.workspace, "child", "must-not-execute");
  await assert.rejects(f.client.processSpawn(f.spawn(processId, "require('node:fs').writeFileSync("+JSON.stringify(marker)+",'unexpected')")));
  const snapshot = await f.client.processInspect({ workspaceId: "ws", processId });
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.writerActive, false);
  assert.equal(snapshot.outputAvailable, false);
  assert.ok(snapshot.reason);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  await f.client.fileRemove({ ...f.address, operationId: "failed-spool-reclaim", path: "child", recursive: true, force: true });
}, 30_000);

it("Host log-drain loss preserves an already confirmed real process exit", async () => {
  const f = await fixture();
  const service = createKernelProcessService({ client: f.host, resolveIdentity: async () => ({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace }) });
  try {
    const child = await service.spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(8*1024*1024,19));process.exitCode=7"], { cwd: path.join(f.workspace, "child"), env: process.env, stdio: "pipe" });
    const completion = assert.rejects(child.completion, /kernel|epoch|pipe|Rust|stream|output/i);
    const deadline = Date.now() + 15_000;
    // Leave the Host readable undrained so its log delivery cannot complete.
    while (child.snapshot.writerActive) {
      if (Date.now() > deadline) throw new Error("Host did not observe terminal control while logs remained unread");
      await pause();
    }
    assert.equal(child.snapshot.status, "exited");
    assert.equal(child.exitCode, 7);
    f.kernelChild.kill("SIGKILL");
    await completion;
    assert.equal(child.snapshot.status, "exited");
    assert.equal(child.snapshot.writerActive, false);
    assert.equal(child.exitCode, 7);
  } finally { await service.dispose().catch(() => undefined); }
}, 30_000);

function outputFiles(f: { storageRoot: string }, processId: string) {
  const prefix = path.join(f.storageRoot, "process-receipts", createHash("sha256").update(processId).digest("hex"));
  return { spool: prefix + ".output", marker: prefix + ".output.complete", receipt: prefix + ".json" };
}
async function reopenProcessFixture(f: { storageRoot: string }) {
  const host = createKernelClient({ hostId: "process-test", storageRoot: f.storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await host.issueGrant({ grantId: "reopened-process-maintenance", owningWorkspace: "ws", executionWorkspace: "ws", pathScopes: [""], capabilities: ["storage.read", "storage.write", "process", "process.maintenance"] }));
  return { host, client };
}

it("completed output reopens byte-exact after kernel restart while old process writes stay forbidden", async () => {
  const f = await fixture();
  const processId = "durable-complete";
  const expected = Buffer.from(Array.from({ length: 131_079 }, (_, index) => index % 251));
  await f.client.processSpawn(f.spawn(processId, "process.stdout.write(Buffer.from(Array.from({length:131079},(_,i)=>i%251)));process.stderr.write('durable-stderr');process.exitCode=7"));
  const before = await drain(f.client, processId);
  assert.deepEqual(before.stdout, expected);
  await f.host.close();
  const reopened = await reopenProcessFixture(f);
  const after = await drain(reopened.client, processId);
  assert.deepEqual(after.stdout, expected);
  assert.equal(after.stderr.toString(), "durable-stderr");
  assert.equal(after.process.writerActive, false);
  assert.equal(after.process.exitCode, 7);
  await assert.rejects(reopened.client.processWrite({ workspaceId: "ws", processId, sequence: 0, bytesBase64: "" }), /stale kernel epoch/);
  await assert.rejects(reopened.client.processKill({ workspaceId: "ws", processId, force: true }), /stale kernel epoch/);
  const files = outputFiles(f, processId);
  await reopened.client.processRelease({ workspaceId: "ws", processId });
  assert.equal(await fs.stat(files.spool).then(() => true, () => false), false);
  assert.equal(await fs.stat(files.marker).then(() => true, () => false), false);
}, 30_000);

it("interrupted retained output exposes only its valid prefix and never reports a complete log", async () => {
  for (const truncated of [false, true]) {
    const f = await fixture();
    const processId = "interrupted-output";
    await f.client.processSpawn(f.spawn(processId, "process.stdout.write('verified-prefix')"));
    await drain(f.client, processId);
    await f.host.close();
    const files = outputFiles(f, processId);
    const spool = await fs.readFile(files.spool);
    const marker = await fs.readFile(files.marker);
    try {
      await fs.rm(files.marker);
      if (truncated) await fs.appendFile(files.spool, Buffer.from([0, 0]));
      const reopened = await reopenProcessFixture(f);
      const read = await reopened.client.processRead({ workspaceId: "ws", processId, cursor: 0 });
      assert.equal(Buffer.concat(read.chunks.map(chunk => Buffer.from(chunk.bytesBase64, "base64"))).toString(), "verified-prefix");
      assert.equal(read.outputComplete, false);
      assert.match(read.outputError ?? "", truncated ? /interrupted.*frame/ : /completion marker/);
      assert.equal(read.process.writerActive, false);
      assert.equal(read.process.status, "exited");
      await reopened.host.close();
    } finally {
      await fs.writeFile(files.spool, spool);
      await fs.writeFile(files.marker, marker);
    }
  }
}, 30_000);

it("corrupt frames or completion identities reject retained logs instead of returning successful empty output", async () => {
  for (const fault of ["frame", "marker", "truncated-marked"] as const) {
    const f = await fixture();
    const processId = "corrupt-output";
    await f.client.processSpawn(f.spawn(processId, "process.stdout.write('durable-evidence')"));
    await drain(f.client, processId);
    await f.host.close();
    const files = outputFiles(f, processId);
    const spool = await fs.readFile(files.spool);
    const marker = await fs.readFile(files.marker);
    try {
      if (fault === "frame") { const corrupt = Buffer.from(spool); corrupt.writeUInt32LE(0, 0); await fs.writeFile(files.spool, corrupt); }
      else if (fault === "marker") { const corrupt = JSON.parse(marker.toString()); corrupt.kernelEpoch = "wrong-epoch"; await fs.writeFile(files.marker, JSON.stringify(corrupt)); }
      else await fs.truncate(files.spool, spool.length - 1);
      const reopened = await reopenProcessFixture(f);
      const snapshot = await reopened.client.processInspect({ workspaceId: "ws", processId });
      assert.equal(snapshot.outputAvailable, false);
      assert.equal(snapshot.writerActive, false);
      assert.equal(snapshot.status, "exited");
      assert.match(snapshot.outputError ?? "", /corrupt|mismatched/);
      await assert.rejects(reopened.client.processRead({ workspaceId: "ws", processId, cursor: 0 }), /corrupt|mismatched/);
      await reopened.host.close();
    } finally {
      await fs.writeFile(files.spool, spool);
      await fs.writeFile(files.marker, marker);
    }
  }
}, 30_000);

it("a missing retained spool is explicit unavailability without erasing the proven process exit", async () => {
  const f = await fixture();
  const processId = "missing-output";
  await f.client.processSpawn(f.spawn(processId, "process.stdout.write('retained')"));
  await drain(f.client, processId);
  await f.host.close();
  const files = outputFiles(f, processId);
  const spool = await fs.readFile(files.spool);
  try {
    await fs.rm(files.spool);
    const reopened = await reopenProcessFixture(f);
    const snapshot = await reopened.client.processInspect({ workspaceId: "ws", processId });
    assert.equal(snapshot.outputAvailable, false);
    assert.equal(snapshot.writerActive, false);
    assert.equal(snapshot.status, "exited");
    await assert.rejects(reopened.client.processRead({ workspaceId: "ws", processId, cursor: 0 }), /output|storage|unavailable/);
    await reopened.host.close();
  } finally { await fs.writeFile(files.spool, spool); }
}, 30_000);

vitestIt.skipIf(!available || process.platform !== "linux")("a complete retained log cannot substitute for missing native tree-exit evidence", async () => {
  const f = await fixture();
  const processId = "complete-log-unknown-writer";
  const initial = await f.client.processSpawn(f.spawn(processId, "process.stdin.once('data',()=>{process.stdout.write('complete-log');process.stdin.destroy()});process.stdin.resume()"));
  assert.equal(initial.writerActive, true);
  await f.client.processWrite({ workspaceId: "ws", processId, sequence: 0, bytesBase64: Buffer.from("go").toString("base64") });
  const files = outputFiles(f, processId);
  const deadline = Date.now() + 15_000;
  // Inspect durable evidence directly, leaving the Storage process snapshot
  // unrefreshed. This is an abrupt restart with separately missing exit proof.
  while (!(await fs.stat(files.marker).then(() => true, () => false)) || !(await fs.stat(files.receipt).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error("Durable output and tree receipt did not arrive");
    await pause();
  }
  const receipt = await fs.readFile(files.receipt);
  const exited = new Promise<void>(resolve => f.kernelChild.once("exit", () => resolve()));
  f.kernelChild.kill("SIGKILL");
  await exited;
  try {
    await fs.rm(files.receipt);
    const reopened = await reopenProcessFixture(f);
    const read = await reopened.client.processRead({ workspaceId: "ws", processId, cursor: 0 });
    assert.equal(read.outputComplete, true);
    assert.equal(read.outputError, null);
    assert.equal(Buffer.concat(read.chunks.map(chunk => Buffer.from(chunk.bytesBase64, "base64"))).toString(), "complete-log");
    assert.equal(read.process.status, "unknown");
    assert.equal(read.process.writerActive, true);
    await assert.rejects(reopened.client.processRelease({ workspaceId: "ws", processId }), /unconfirmed|in use/);
    const registered = await reopened.client.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace });
    await assert.rejects(reopened.client.fileRemove({ workspaceId: "ws", rootId: String(registered.rootId), operationId: "unknown-log-reclaim", path: "child", recursive: true, force: true }), /writer|exit/);
    await reopened.host.close();
  } finally { await fs.writeFile(files.receipt, receipt); }
}, 30_000);

it("a held subscription data credit cannot block stdin acknowledgements or native tree termination", async () => {
  const f = await fixture();
  const processId = "slow-subscription";
  const marker = path.join(f.workspace, "child", "subscription-output-ready");
  await f.client.processSpawn(f.spawn(processId, "const fs=require('node:fs'),b=Buffer.alloc(65536,61);for(let i=0;i<128;i++)fs.writeSync(1,b);fs.writeFileSync("+JSON.stringify(marker)+",'ready');process.stdin.resume();setInterval(()=>{},1000)"));
  let dataEvents = 0;
  let inputSequence = -1;
  let terminal: KernelProcessSnapshot | undefined;
  let observerFailure: unknown;
  const subscription = await f.client.processSubscribe({ workspaceId: "ws", processId, cursor: 0 }, (event, acknowledge) => {
    if (event.stream === "data") {
      assert.ok(event.result);
      const byteLength = event.result.chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.bytesBase64, "base64").length, 0);
      assert.ok(byteLength > 0 && byteLength <= 64 * 1024);
      dataEvents += 1;
      // Deliberately keep the single data credit until this observer closes.
    } else if (event.stream === "control") {
      assert.ok(event.result);
      inputSequence = event.result.inputSequence;
      if (!event.result.process.writerActive) terminal = event.result.process;
      void acknowledge().catch(error => { observerFailure = error; });
    }
  });
  try {
    const deadline = Date.now() + 15_000;
    while (dataEvents === 0 || !(await fs.stat(marker).then(() => true, () => false))) {
      if (observerFailure) throw observerFailure;
      if (Date.now() > deadline) throw new Error("Subscription did not deliver initial output");
      await pause();
    }
    const input = { workspaceId: "ws", processId, sequence: 0, bytesBase64: Buffer.from("ack-me").toString("base64") };
    await f.client.processWrite(input);
    while (inputSequence < 0) {
      if (observerFailure) throw observerFailure;
      if (Date.now() > deadline) throw new Error("Held data credit blocked stdin acknowledgement");
      await pause();
    }
    assert.equal(dataEvents, 1);
    assert.equal((await f.client.health()).integrity, "ok");
    await f.client.processKill({ workspaceId: "ws", processId, force: true });
    while (!terminal) {
      if (observerFailure) throw observerFailure;
      if (Date.now() > deadline) throw new Error("Held data credit blocked terminal control event");
      await pause();
    }
    assert.equal(terminal.status, "exited");
    assert.equal(dataEvents, 1);
  } finally { await subscription.close(); }
  if (process.platform === "linux") {
    const deadline = Date.now() + 15_000;
    // No process.inspect/read request follows terminal control before this
    // assertion: guardian collection must not depend on a later observer.
    const taskRoot = `/proc/${f.kernelChild.pid}/task`;
    const childIds = async () => {
      const tids = await fs.readdir(taskRoot);
      const children = await Promise.all(tids.map(tid => fs.readFile(path.join(taskRoot, tid, "children"), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; // A worker thread ended during the snapshot.
        throw error;
      })));
      return children.join(" ").trim();
    };
    while (await childIds()) {
      if (Date.now() > deadline) throw new Error("Terminated guardian was not reaped without polling process state");
      await pause();
    }
  }
  const read = await drain(f.client, processId);
  assert.deepEqual(read.stdout, Buffer.alloc(8*1024*1024,61));
}, 30_000);
