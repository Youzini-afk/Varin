import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, it as test } from "vitest";
import { createKernelClient, type KernelScopedClient } from "./kernel-client.js";
import { runKernelCompute, type KernelComputeInput } from "./compute-runner.js";
import { createKernelComputeService } from "./compute-service.js";
import type { KernelComputeRecord, KernelEntry } from "./protocol.generated.js";
import { createTreeSitterStructureProvider } from "../structure/tree-sitter-provider.js";
import { createStructureSource } from '../structure/source.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { createSemanticIndexRuntime } from '../knowledge/semantic/runtime.js';
import { createHashEmbedder } from '../knowledge/semantic/embedder.js';
import { workspaceScope } from '../knowledge/semantic/identity.js';
import { createFsSearchRuntime } from '../fs/search.js';
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

it('streams the same exhaustive baseline paths as file.scan, including explicit hidden scopes', async () => {
  const f = await fixture();
  const files = ['.gitignore', '.hidden/note', 'ignored/note', '.git/config', '.varin/state', 'src/main.ts'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(f.workspace, file)), { recursive: true });
    await fs.writeFile(path.join(f.workspace, file), file === '.gitignore' ? 'ignored/\n' : 'content');
  }
  for (const scopes of [undefined, ['.varin', '.hidden'], ['absent/nested', 'src']]) {
    const expected = await f.client.fileScan({ ...f.address, path: '', ...(scopes ? { scopes } : {}) });
    const observed = await runKernelCompute(f.client, {
      ...f.address, operation: 'inventory', lane: 'foreground', paths: scopes ?? [''],
    });
    assert.ok(['ready', 'empty'].includes(observed.status), observed.message ?? undefined);
    assert.deepEqual(observed.records.map(record => record.path).sort(), expected.paths);
  }
});

it('compares native content before parsing and retains complete coverage for many sibling functions', async () => {
  const f = await fixture();
  const text = Array.from({ length: 3000 }, (_, n) => `export function fn_${n}() { return ${n}; }`).join('\n');
  await fs.writeFile(path.join(f.workspace, 'large.ts'), text);
  const provider = createTreeSitterStructureProvider({ compute: f.service, parseBudgetMs: 30000 });
  const request = { workspaceId: 'ws', root: f.workspace, path: 'large.ts', languageId: 'typescript', lane: 'background' as const };
  const first = await provider.unitsFile!(request);
  assert.equal(first.status, 'ready', first.message);
  assert.equal(first.units.length, 3000);
  assert.equal(first.units.map(unit => unit.text).join('\n'), text);
  assert.ok(first.sourceMetadata?.modifiedTimeNs);
  const unchanged = await provider.unitsFile!({ ...request, unchangedRevision: first.revision });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.units.length, 0);
  assert.equal(unchanged.revision, first.revision);
  assert.deepEqual(unchanged.sourceMetadata, first.sourceMetadata);
  await fs.writeFile(path.join(f.workspace, 'large.ts'), 'export function replacement() {}');
  const changed = await provider.unitsFile!({ ...request, unchangedRevision: first.revision });
  assert.notEqual(changed.unchanged, true);
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.units[0]?.parentName, 'replacement');
}, 60000);

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
it('explains a parent-ignored directory and permits an explicit directory enumeration', async () => {
  const f = await fixture();
  execFileSync('git', ['init', '--quiet'], { cwd: f.workspace, stdio: 'ignore' });
  await fs.writeFile(path.join(f.workspace, '.gitignore'), 'data/raw/\n');
  const selected = path.join(f.workspace, 'data/raw');
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(selected, 'source.scala'), 'object Source {}\n');
  const filtered = await f.service.directory(selected, { operation: 'list', lane: 'background', includeTracked: true, respectGitignore: true });
  assert.equal(filtered.status, 'ready', JSON.stringify(filtered));
  assert.equal(filtered.records.filter(record => record.kind === 'entry' && data(record).kind === 'file').length, 0);
  const info = filtered.records.find(record => record.kind === 'inventory');
  assert.equal(data(info!).selectedRootIgnored, true);
  assert.equal(await fs.realpath(String(data(info!).gitRoot)), await fs.realpath(f.workspace));
  const included = await f.service.directory(selected, { operation: 'list', lane: 'background', includeTracked: true, respectGitignore: false });
  assert.ok(included.records.some(record => record.kind === 'entry' && record.path === 'source.scala'));
  execFileSync('git', ['init', '--quiet'], { cwd: selected, stdio: 'ignore' });
  const independent = await f.service.directory(selected, { operation: 'list', lane: 'background', includeTracked: true, respectGitignore: true });
  assert.ok(independent.records.some(record => record.kind === 'entry' && record.path === 'source.scala'));
  await fs.rm(path.join(selected, 'source.scala'));
  const empty = await f.service.directory(selected, { operation: 'list', lane: 'background', includeTracked: true, respectGitignore: true });
  assert.equal(data(empty.records.find(record => record.kind === 'inventory')!).selectedRootIgnored, false);
});

it('keeps nested Git visibility under a non-Git project parent and checks exact filenames', async () => {
  const f = await fixture();
  const repo = path.join(f.workspace, 'nested');
  await fs.mkdir(path.join(repo, 'generated'), { recursive: true });
  await fs.writeFile(path.join(repo, '.gitignore'), 'generated/\n');
  await fs.writeFile(path.join(repo, 'source.ts'), 'export const source = 1;\n');
  await fs.writeFile(path.join(repo, 'generated', 'ignored.ts'), 'ignored\n');
  await fs.writeFile(path.join(repo, 'generated', 'tracked.ts'), 'tracked\n');
  await fs.writeFile(path.join(repo, 'literal[1].ts'), 'literal\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '-f', '--', 'generated/tracked.ts'], { cwd: repo, stdio: 'ignore' });
  const inventory = await f.service.directory(f.workspace, { operation: 'list', lane: 'background',
    includeTracked: true, respectGitignore: true });
  const paths = inventory.records.filter(record => record.kind === 'entry' && data(record).kind === 'file').map(record => record.path);
  assert.ok(paths.includes('nested/source.ts'));
  assert.ok(paths.includes('nested/generated/tracked.ts'));
  assert.ok(!paths.includes('nested/generated/ignored.ts'), JSON.stringify(paths));
  const exact = await f.service.directory(f.workspace, { operation: 'list', lane: 'background',
    includeTracked: true, respectGitignore: true, files: [{ path: 'nested/literal[1].ts' }], paths: ['nested/literal[1].ts'] });
  assert.deepEqual(exact.records.filter(record => record.kind === 'entry' && data(record).kind === 'file').map(record => record.path), ['nested/literal[1].ts']);
});

it('indexes Scala through native text units and validates returned source revisions', async () => {
  const f = await fixture();
  execFileSync('git', ['init', '--quiet'], { cwd: f.workspace, stdio: 'ignore' });
  await fs.writeFile(path.join(f.workspace, '.gitignore'), 'data/raw/\n');
  const selected = path.join(f.workspace, 'data/raw');
  await fs.mkdir(selected, { recursive: true });
  const file = path.join(selected, 'Main.scala');
  const documentId = 'data/raw/Main.scala';
  const text = 'object Main {\n  def uniqueScalaMarker = 42\n}\n';
  await fs.writeFile(file, text);
  const documents = createDocumentAuthority({ hostId: 'scala-index', dataDir: path.join(f.root, 'documents'),
    isAllowedRoot: async () => true, isTrusted: async () => true });
  cleanup.push(() => documents.dispose());
  const { workspaceId } = await documents.resolveWorkspace({ path: f.workspace });
  const provider = createTreeSitterStructureProvider({ compute: f.service });
  const units = await provider.unitsFile!({ workspaceId, root: f.workspace, path: documentId, languageId: 'scala' });
  assert.equal(units.status, 'ready', JSON.stringify(units));
  assert.ok(units.units.length > 0 && units.units.every(unit => unit.fallback && unit.parentKind === 'file'));
  const runtime = createSemanticIndexRuntime({ dataDir: f.root, hostId: 'scala-index', documents,
    structureSource: createStructureSource([provider]), embedder: createHashEmbedder(),
    indexDirectories: [selected], includeIgnoredDirectories: [selected],
    searchFilesystemFiles: createFsSearchRuntime({ compute: f.service }).searchFilesystemFiles });
  cleanup.push(() => runtime.dispose());
  const scope = workspaceScope(workspaceId);
  await runtime.scanScope(scope);
  const result = await runtime.search(scope, 'uniqueScalaMarker', 5);
  assert.ok(result.hits.some(hit => hit.documentId === documentId && hit.body.includes('uniqueScalaMarker') && hit.fallback),
    JSON.stringify({ result, progress: runtime.scanProgress(scope) }));
  assert.equal(result.hits[0]?.revision, units.revision);
  assert.equal(runtime.scanProgress(scope)?.coverageStats?.textFallbackFiles, 1);
  assert.equal(runtime.scanProgress(scope)?.coverageStats?.structurallySupportedFiles, 0);
  await fs.writeFile(file, '// changed\n' + text);
  const changed = await runtime.search(scope, 'uniqueScalaMarker', 5);
  assert.ok(changed.hits.every(hit => hit.revision !== units.revision));
}, 30000);

it('resolves directory aliases within the admitted root and rejects aliases outside it', async () => {
  const f = await fixture();
  const source = path.join(f.workspace, 'src');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'entry.scala'), 'object AliasSource {}\n');
  const alias = path.join(f.root, 'workspace-alias');
  await fs.symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  // Exercise a caller alias and a canonical caller against the original
  // admission spelling, which can itself be a short path on Windows CI.
  for (const cwd of [path.join(alias, 'src'), await fs.realpath(source)]) {
    const streamed: string[] = [];
    const result = await f.service.directory(cwd, {
      operation: 'read', lane: 'foreground', paths: ['entry.scala'],
    }, { onRecords: records => { streamed.push(...records.map(record => record.path)); } });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.records.map(record => data(record).text).join(''), 'object AliasSource {}\n');
    assert.deepEqual(result.records.map(record => record.path), ['entry.scala']);
    assert.deepEqual(streamed, ['entry.scala']);
  }
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.scala'), 'object Outside {}\n');
  const escape = path.join(f.workspace, 'escape');
  await fs.symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.directory(escape, { operation: 'list', lane: 'foreground' }), /escaped|admitted/i);
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

it('uses captured byte identities for live, pinned and opaque-revision structure inputs', async () => {
  const f = await fixture();
  const file = 'identity.ts';
  const original = "export function original() { return '中文😀'; }\r\n";
  await fs.writeFile(path.join(f.workspace, file), original);
  const pin = await f.branch({ [file]: original });
  const object = await f.client.putBlob(Buffer.from(original), 'identity-fixed-object');
  const recipeId = await f.service.registerGrammar({
    recipeId: '', grammarName: '', style: 'code',
    grammarPath: path.join(repo, 'packages/web/application-host/lib/structure/runtime/tree-sitter-typescript.wasm'),
    definitionQuery: TYPESCRIPT_DEFINITION_QUERY,
    importQuery: TYPESCRIPT_IMPORT_QUERY, literalCallQuery: TYPESCRIPT_LITERAL_CALL_QUERY,
  });
  const expectedHash = createHash('sha256').update(original).digest('hex');
  const expectedRevision = 'd1_' + Buffer.from(expectedHash, 'hex').toString('base64url');
  const inputs: Array<Omit<KernelComputeInput, 'operation' | 'lane'>> = [
    { ...f.address },
    { workspaceId: 'ws', pinId: String(pin.pinId) },
    { workspaceId: 'ws', objects: [{ path: file, revision: 'draft:opaque',
      objectHash: object.hash, ownerId: object.ownerId }] },
  ];
  for (const [index, source] of inputs.entries()) {
    const result = await runKernelCompute(f.client, { ...source, operation: 'structure', lane: 'background',
      paths: [file], files: [{ path: file, recipeId }], parseBudgetMs: 30000 });
    assert.equal(result.status, 'ready', result.message ?? undefined);
    const structure = result.records.find(record => record.kind === 'structure')!;
    assert.equal(structure.revision, index === 2 ? 'draft:opaque' : expectedRevision);
    assert.equal(data(structure).contentHash, expectedHash);
    assert.ok(result.records.some(record => record.kind === 'structure-part'
      && data(record).category === 'symbols' && JSON.stringify(data(record).items).includes('original')));
  }
  const changed = "export function changed() {}\n";
  await fs.writeFile(path.join(f.workspace, file), changed);
  const result = await runKernelCompute(f.client, { ...f.address, operation: 'structure', lane: 'background',
    paths: [file], files: [{ path: file, recipeId }], parseBudgetMs: 30000 });
  const structure = result.records.find(record => record.kind === 'structure')!;
  assert.equal(data(structure).contentHash, createHash('sha256').update(changed).digest('hex'));
  assert.notEqual(structure.revision, expectedRevision);
  assert.ok(result.records.some(record => record.kind === 'structure-part'
    && data(record).category === 'symbols' && JSON.stringify(data(record).items).includes('changed')));
}, 60000);

it('fixed branch revision discovery enforces the scoped grant and retains cancellable native readers', async () => {
  const f = await fixture();
  await f.branch({ 'allowed/a.txt': 'needle fixed', 'secret/a.txt': 'needle hidden', 'allowed/large.txt': ('needle ' + 'x'.repeat(1000) + '\n').repeat(4000) });
  await fs.mkdir(path.join(f.workspace, 'allowed'));
  await fs.writeFile(path.join(f.workspace, 'allowed/a.txt'), 'needle drifting disk');
  const narrow = await f.scoped('direct-branch-reader', ['allowed']);
  const result = await runKernelCompute(narrow, { workspaceId: 'ws', branchId: 'branch', revision: 0, operation: 'search', query: 'needle', paths: ['allowed/a.txt'], lane: 'foreground' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.records.map(record => [record.path, data(record).preview]), [['allowed/a.txt', 'needle fixed']]);
  const listed = await runKernelCompute(narrow, { workspaceId: 'ws', branchId: 'branch', revision: 0, operation: 'list', lane: 'foreground', paths: [''] });
  assert.ok(listed.records.every(record => record.path.startsWith('allowed')));
  assert.ok(listed.records.some(record => record.path === 'allowed/a.txt'));
  await assert.rejects(runKernelCompute(narrow, { workspaceId: 'ws', branchId: 'branch', revision: 0, operation: 'read', files: [{ path: 'secret/a.txt' }], lane: 'foreground' }), /scope|grant/i);
  const other = f.host.scoped(await f.host.issueGrant({ grantId: 'wrong-branch-workspace', owningWorkspace: 'other-ws', executionWorkspace: 'other-ws', capabilities: ['storage.read'], pathScopes: [''] }));
  await assert.rejects(runKernelCompute(other, { workspaceId: 'other-ws', branchId: 'branch', revision: 0, operation: 'list', lane: 'foreground' }), /workspace/i);
  await narrow.computeStart({ workspaceId: 'ws', jobId: 'direct-cancel', branchId: 'branch', revision: 0, operation: 'search', query: 'needle', paths: ['allowed/large.txt'], lane: 'background' });
  await narrow.computeCancel({ workspaceId: 'ws', jobId: 'direct-cancel' });
  for (let attempt = 0;; attempt++) { const state = await narrow.computeRead({ workspaceId: 'ws', jobId: 'direct-cancel', cursor: 0 }); if (state.status === 'cancelled') break; assert.ok(attempt < 300, 'native cancellation must reach a terminal record'); await sleep(); }
  await narrow.computeRelease({ workspaceId: 'ws', jobId: 'direct-cancel' });
}, 30_000);
