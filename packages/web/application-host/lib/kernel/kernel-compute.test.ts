import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, it as test } from "vitest";
import { createKernelClient, type KernelScopedClient } from "./kernel-client.js";
import { runKernelCompute } from "./compute-runner.js";
import { createKernelComputeService } from "./compute-service.js";
import type { KernelComputeRecord, KernelEntry } from "./protocol.generated.js";
import { createTreeSitterStructureProvider } from "../structure/tree-sitter-provider.js";
import { TYPESCRIPT_DEFINITION_QUERY, TYPESCRIPT_IMPORT_QUERY, TYPESCRIPT_LITERAL_CALL_QUERY } from "../structure/queries.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repo, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") throw new Error("Native computation acceptance requires a release kernel");
const it = test.skipIf(!available);
const buildVersion = (JSON.parse(await fs.readFile(path.join(repo,"package.json"),"utf8")) as { version: string }).version;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const data = (r: KernelComputeRecord): Record<string, unknown> => r.data as Record<string, unknown>;
const sleep = (ms = 10) => new Promise<void>(r => setTimeout(r, ms));
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"varin-compute-"));
  const workspace = path.join(root,"workspace"); await fs.mkdir(workspace);
  const host = createKernelClient({ hostId:"compute-test",storageRoot:path.join(root,"storage"),kernelPath,buildVersion,allowCargoDevRunner:false });
  cleanup.push(async () => { await host.close(); await fs.rm(root,{recursive:true,force:true}); });
  await host.start();
  const scoped = async (id: string, scopes = [""]) => host.scoped(await host.issueGrant({ grantId:id,owningWorkspace:"ws",executionWorkspace:"ws",capabilities:["storage.read","storage.write","storage.gc"],pathScopes:scopes }));
  const client = await scoped("query-owner");
  const registered = await client.fileRootRegister({workspaceId:"ws",executionWorkspaceId:"ws",canonicalRoot:workspace});
  const service = createKernelComputeService({client:host,resolveIdentity:async()=>({workspaceId:"ws",executionWorkspaceId:"ws",canonicalRoot:workspace})});
  cleanup.push(()=>service.dispose());
  const entries = async (files: Record<string,string>): Promise<KernelEntry[]> => Promise.all(Object.entries(files).map(async ([file,text]) => {
    const blob = await client.putBlob(Buffer.from(text),"body:"+file);
    return {path:file,state:{kind:"regular-file" as const,objectHash:blob.hash,byteLength:blob.byteLength,mode:0o644},ownerId:blob.ownerId};
  }));
  const branch = async (files: Record<string,string>, branchId="branch") => {
    await client.createBranch({operationId:"create:"+branchId,workspaceId:"ws",branchId,draftBasePaths:[],captureScopes:[],entries:await entries(files)});
    return client.pinBranch({operationId:"pin:"+branchId,branchId,pinId:"pin:"+branchId});
  };
  return { root,workspace,host,client,service,scoped,branch,address:{workspaceId:"ws",rootId:String(registered.rootId)} };
}
const drain = (client: KernelScopedClient, pinId: string, operation="search", query="needle") => runKernelCompute(client,{workspaceId:"ws",pinId,operation,query,lane:"foreground",includeHidden:true,paths:[""]});

it("R5 searches pinned bytes, not drifting parent disk, and reads a fixed range", async()=>{
  const f=await fixture();const pin=await f.branch({"src/a.ts":"first\nneedle fixed\nlast","gone.txt":"not relevant"});
  await fs.mkdir(path.join(f.workspace,"src"));await fs.writeFile(path.join(f.workspace,"src/a.ts"),"needle live");await fs.writeFile(path.join(f.workspace,"unborn.txt"),"needle unrelated");
  const result=await drain(f.client,String(pin.pinId));
  assert.equal(result.status,"ready"); assert.deepEqual(result.records.map(r=>[r.path,data(r).preview]),[["src/a.ts","needle fixed"]]);
  const read=await runKernelCompute(f.client,{workspaceId:"ws",pinId:String(pin.pinId),operation:"read",lane:"foreground",paths:["src/a.ts"],startLine:2,endLine:2});
  assert.equal(read.records.map(r=>data(r).text).join(""),"needle fixed");
});
it("R5 applies drafts and ancestor tombstones before candidate limits",async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.workspace,"deleted"));await fs.writeFile(path.join(f.workspace,"deleted/secret.txt"),"needle hidden");await fs.writeFile(path.join(f.workspace,"a.txt"),"needle stale");await fs.writeFile(path.join(f.workspace,"z.txt"),"needle disk");
  const result=await f.service.directory(f.workspace,{operation:"search",lane:"foreground",query:"needle",maxResults:1}, {},[{path:"deleted",revision:"draft-delete",missing:true},{path:"a.txt",revision:"draft:2",text:"needle DRAFT"}]);
  assert.deepEqual(result.records.filter(r=>r.kind==="hit").map(r=>[r.path,r.revision,data(r).preview]),[["a.txt","draft:2","needle DRAFT"]]);
  const all=await f.service.directory(f.workspace,{operation:"search",lane:"foreground",query:"needle"}, {},[{path:"deleted",revision:"draft-delete",missing:true},{path:"a.txt",revision:"draft:2",text:"needle DRAFT"}]);
  assert.ok(!all.records.some(r=>r.path.startsWith("deleted/")));
});
it("R5 constrains candidates by grant scope before matching or budget",async()=>{
  const f=await fixture();await f.branch({"allowed/a.txt":"needle allowed","secret/a.txt":"needle secret"});
  const narrow=await f.scoped("narrow",["allowed"]);
  const p=await narrow.pinBranch({operationId:"narrow-pin",branchId:"branch",pinId:"narrow-pin"});
  const result=await drain(narrow,String(p.pinId));assert.deepEqual(result.records.map(r=>r.path),["allowed/a.txt"]);
  await assert.rejects(runKernelCompute(narrow,{workspaceId:"ws",pinId:String(p.pinId),lane:"foreground",operation:"read",files:[{path:"secret/a.txt"}]}),/scope|grant/i);
});
it("R5 reads UTF-8 matches with UTF-16 columns and same-revision context",async()=>{
  const f=await fixture();const result=await f.service.text("ws",[{path:"a.ts",revision:"draft",text:"head\n中文😀 needle\ntail"}],{lane:"foreground",operation:"search",query:"needle",before:1,after:1});
  assert.equal(result.status,"ready");assert.deepEqual(data(result.records[0]!),{line:2,column:6,preview:"中文😀 needle",before:["head"],after:["tail"]});
  const bad=await f.service.text("ws",[{path:"a.ts",revision:"draft",text:"foo"}],{lane:"foreground",operation:"search",query:"["});assert.equal(bad.status,"failed");
});
it("R5 retained readers survive caller unpin, branch delete and concurrent GC",async()=>{
  const f=await fixture();const pin=await f.branch({"big.txt":("needle "+"x".repeat(1000)+"\n").repeat(4000)});
  const job=await f.client.computeStart({workspaceId:"ws",jobId:"blocked",pinId:String(pin.pinId),operation:"search",query:"needle",lane:"background"});
  await f.client.unpinBranch({operationId:"unpin-caller",branchId:"branch",pinId:String(pin.pinId)});
  await f.client.deleteBranch({operationId:"delete-caller",branchId:"branch"});
  await f.client.gc("gc-during-reader");
  let page=job,cursor=0,count=0;for(;;){count+=page.records.length;cursor=page.nextCursor;if(!["queued","running"].includes(page.status)&&cursor===page.endCursor)break;page=await f.client.computeRead({workspaceId:"ws",jobId:"blocked",cursor});await sleep(1);}
  assert.equal(count,4000);assert.equal(page.status,"ready");await f.client.computeRelease({workspaceId:"ws",jobId:"blocked"});
  assert.equal((await f.client.gc("gc-after-reader")).releasedBlobs,1);
},30000);
it("R5 foreground reads proceed while a background query is backpressured; cancellation really stops it",async()=>{
  const f=await fixture();const pin=await f.branch({"big.txt":("needle "+"x".repeat(1000)+"\n").repeat(4000),"small.txt":"short"});
  await f.client.computeStart({workspaceId:"ws",jobId:"background",pinId:String(pin.pinId),operation:"search",query:"needle",lane:"background"});await sleep(100);
  await assert.rejects(f.client.computeRelease({workspaceId:"ws",jobId:"background"}),/active|retained/i);
  const start=Date.now();const read=await runKernelCompute(f.client,{workspaceId:"ws",pinId:String(pin.pinId),lane:"foreground",operation:"read",paths:["small.txt"]});
  assert.equal(read.records.map(r=>data(r).text).join(""),"short");assert.ok(Date.now()-start<3000);
  await f.client.computeCancel({workspaceId:"ws",jobId:"background"});
  for(let i=0;;i++){const status=await f.client.computeRead({workspaceId:"ws",jobId:"background",cursor:0});if(status.status==="cancelled")break;assert.ok(i<300);await sleep();}
  await f.client.computeRelease({workspaceId:"ws",jobId:"background"});
},30000);
it("R5 grammar WASM, queries, structure batches and fixed text run in native tree-sitter",async()=>{
  const f=await fixture();const recipeId=await f.service.registerGrammar({recipeId:"",grammarPath:path.join(repo,"packages/web/application-host/lib/structure/runtime/tree-sitter-typescript.wasm"),grammarName:"",style:"code",definitionQuery:TYPESCRIPT_DEFINITION_QUERY,importQuery:TYPESCRIPT_IMPORT_QUERY,literalCallQuery:TYPESCRIPT_LITERAL_CALL_QUERY});
  const result=await f.service.text("ws",[{path:"a.ts",revision:"draft:1",text:"import { x } from './x';\nexport function example() {\n // note\n return fetch('/api/example');\n}\n"}],{lane:"foreground",operation:"structure",files:[{path:"a.ts",recipeId,revision:"draft:1",lines:[2,3,4]}],parseBudgetMs:30000});
  assert.equal(result.status,"ready",JSON.stringify(result));
  const parts=result.records.filter(r=>r.kind==="structure-part");
  assert.ok(parts.some(r=>data(r).category==="symbols"&&JSON.stringify(data(r).items).includes("example")));
  assert.ok(parts.some(r=>data(r).category==="imports"&&JSON.stringify(data(r).items).includes("./x")));
  assert.ok(parts.some(r=>data(r).category==="calls"&&JSON.stringify(data(r).items).includes("/api/example")));
  assert.ok(result.records.every(r=>r.revision==="draft:1"));
},60000);
it("R5 native directory inventory applies Git ignore rules while retaining force-tracked ignored files",async()=>{
  const f=await fixture();
  await fs.mkdir(path.join(f.workspace,"src"),{recursive:true});
  await fs.mkdir(path.join(f.workspace,"generated"),{recursive:true});
  await fs.writeFile(path.join(f.workspace,"src/a.ts"),"export const a = 1;\n");
  await fs.writeFile(path.join(f.workspace,"generated/ignored.ts"),"export const ignored = 1;\n");
  await fs.writeFile(path.join(f.workspace,"generated/tracked.ts"),"export const tracked = 1;\n");
  await fs.writeFile(path.join(f.workspace,".gitignore"),"generated/\n");
  execFileSync("git",["init","--quiet"],{cwd:f.workspace,stdio:"ignore"});
  execFileSync("git",["add","-f","--","generated/tracked.ts"],{cwd:f.workspace,stdio:"ignore"});
  const inventory=await f.service.directory(f.workspace,{operation:"list",lane:"background",respectGitignore:true,includeTracked:true});
  const inventoryFiles=inventory.records.filter(r=>r.kind==="entry"&&(data(r).kind==="file"));
  const inventoryTracked=inventoryFiles.find(r=>r.path==="generated/tracked.ts");
  const metadata=data(inventoryTracked!).metadata as {byteLength:string;modifiedTimeNs:string};
  assert.equal(inventoryTracked?.revision,"");
  assert.equal(metadata.byteLength,String(Buffer.byteLength("export const tracked = 1;\n")));
  assert.ok(metadata.modifiedTimeNs);
  const listed=await f.service.directory(f.workspace,{operation:"list",lane:"background",respectGitignore:true,includeTracked:true,includeRevisions:true});
  const paths=listed.records.filter(r=>r.kind==="entry"&&(data(r).kind==="file")).map(r=>r.path).sort();
  assert.ok(paths.includes("src/a.ts"),JSON.stringify(paths));
  assert.ok(paths.includes("generated/tracked.ts"),JSON.stringify(paths));
  assert.ok(!paths.includes("generated/ignored.ts"),JSON.stringify(paths));
  const tracked=listed.records.find(r=>r.path==="generated/tracked.ts");
  assert.ok(tracked?.revision,"inventory entries must carry their native revision");
});
it("R5 structure provider analyzes and chunks a disk file directly through native compute",async()=>{
  const f=await fixture();
  await fs.mkdir(path.join(f.workspace,"src"),{recursive:true});
  const text="import { join } from 'node:path';\nexport function diskFunction() {\n  return join('a','b');\n}\n";
  await fs.writeFile(path.join(f.workspace,"src/disk.ts"),text);
  const provider=createTreeSitterStructureProvider({compute:f.service,parseBudgetMs:30000});
  assert.ok(provider.analyzeFile&&provider.unitsFile&&provider.unitsFixed);
  const analysis=await provider.analyzeFile!({workspaceId:"ws",root:f.workspace,path:"src/disk.ts",languageId:"typescript",lane:"background",lines:[2,3]});
  assert.equal(analysis.outline.status,"ready",JSON.stringify(analysis));
  assert.ok(analysis.outline.symbols.some(symbol=>symbol.name==="diskFunction"),JSON.stringify(analysis.outline));
  assert.deepEqual(analysis.lineLengths,text.split("\n").map(line=>line.length));
  assert.ok(analysis.outline.revision);
  const units=await provider.unitsFile!({workspaceId:"ws",root:f.workspace,path:"src/disk.ts",languageId:"typescript",lane:"background"});
  assert.equal(units.status,"ready",JSON.stringify(units));
  assert.equal(units.revision,analysis.outline.revision);
  assert.ok(units.units.some(unit=>unit.parentName==="diskFunction"&&unit.text.includes("join('a','b')")),JSON.stringify(units));
  const pin=await f.branch({"src/pinned.ts":text},"structure-pin");
  const listed=await runKernelCompute(f.client,{workspaceId:"ws",pinId:String(pin.pinId),operation:"list",lane:"foreground",paths:["src/pinned.ts"]});
  const fileRevision=listed.records.find(record=>record.path==="src/pinned.ts")?.revision;
  assert.ok(fileRevision,"fixed inventory requires the same content identity without re-reading bodies");
  const fixed=await provider.unitsFixed!({
    workspaceId:"ws",path:"src/pinned.ts",languageId:"typescript",lane:"foreground",
    compute:(input,options)=>runKernelCompute(f.client,{...input,workspaceId:"ws",pinId:String(pin.pinId)},options),
  });
  assert.equal(fixed.status,"ready",JSON.stringify(fixed));
  assert.equal(fixed.revision,fileRevision,"pin inventory and native structural units must share the document revision");
  assert.ok(fixed.revision);
  assert.ok(fixed.units.some(unit=>unit.parentName==="diskFunction"&&unit.text.includes("join('a','b')")),JSON.stringify(fixed));
},60000);
it("R5 refuses root replacement and does not report failed traversal as successful empty",async()=>{
  const f=await fixture();const outside=path.join(f.root,"outside");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"secret.txt"),"needle");
  await fs.rename(f.workspace,f.workspace+"-saved");await fs.symlink(outside,f.workspace,process.platform==="win32"?"junction":"dir");
  await assert.rejects(runKernelCompute(f.client,{...f.address,lane:"foreground",operation:"search",query:"needle"}),/root|identity|changed/i);
});
