import assert from "node:assert/strict";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.test-helper.js";
import { createShellSupervisor } from "../harness/shell-supervisor.js";
import { createOutputStore } from "../harness/output-store.js";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  const host = createKernelClient({ hostId: "process-test", storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false, env,
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
  return { root, workspace, storageRoot, host, client, scoped, address, spawn, kernelChild: kernelChild! };
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
    if (!result.process.writerActive && cursor === result.endCursor) {
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

it("raw output above the native buffer bound is drained without truncation or freezing control", async () => {
  const f = await fixture();
  await f.client.processSpawn(f.spawn("large", "process.stdout.write(Buffer.alloc(3*1024*1024,173));process.stderr.write('done')"));
  await waitFor(f.client, "large", (s) => s.pid !== null);
  await pause(200);
  assert.equal((await f.client.health()).integrity, "ok");
  const result = await drain(f.client, "large");
  assert.deepEqual(result.stdout, Buffer.alloc(3*1024*1024,173));
  assert.equal(result.stderr.toString(), "done");
}, 30_000);

it("the Host stream adapter keeps binary I/O and delivers close before completion", async () => {
  const f = await fixture();
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
  assert.equal(receipt.outputAvailable,false);
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
    assert.equal(record.outputAvailable,false);
  } finally {
    if(host.exitCode===null&&host.signalCode===null){const stopped=new Promise<void>(resolve=>host.once("exit",()=>resolve()));host.kill("SIGKILL");await stopped;}
  }
},30_000);
