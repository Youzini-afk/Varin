import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [container, output] = process.argv.slice(2);
const root = '/home/varin/workspaces/memory-fixture';
const corpus = `${root}/corpus`;
const files = 256, bytesPerFile = 65536;
const filename = i => `file-${String(i).padStart(4, '0')}.txt`;
function contents(i) {
  const data = Buffer.alloc(65536, 'x');
  data.write(`varin-memory-fixture-${i}\n`);
  data[data.length - 1] = 10;
  return data;
}
const sha = data => createHash('sha256').update(data).digest('hex');
const expectedAggregate = sha(Array.from({length: files}, (_, i) => `${sha(contents(i))}  corpus/${filename(i)}\n`).join(''));
const command = "find corpus -type f -name '*.txt' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum";
execFileSync('docker', ['exec', container, 'node', '-e', `
const fs = require('node:fs');
const contents = ${contents.toString()};
fs.mkdirSync(${JSON.stringify(corpus)}, {recursive:true});
for(let i=0;i<256;i++) fs.writeFileSync(${JSON.stringify(corpus)}+'/file-'+String(i).padStart(4,'0')+'.txt',contents(i));
`], {stdio:'inherit'});

const base = 'http://127.0.0.1:3000';
const login = await fetch(`${base}/auth/session`, {method:'POST', headers:{'content-type':'application/json',origin:base},
  body: JSON.stringify({password:'varin-memory-fixture-only'})});
assert.equal(login.status, 200, 'test-only login failed');
assert.equal((await login.json()).authenticated, true);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'login did not issue a session cookie');
const headers = {cookie, origin:base, 'content-type':'application/json', 'x-varin-directory':root};
async function request(route, body, asText = false) {
  const response = await fetch(base + route, {method:body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(30000)});
  const text = await response.text();
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}: ${text.slice(0,500)}`);
  return {data:asText ? text : JSON.parse(text), bytes:Buffer.byteLength(text)};
}
const setup = await request('/api/workspace/projects/open', {path:'memory-fixture'});
assert.equal(setup.data.success,true,'fixture project was not opened');
const threads = [];
for(let i=0;i<32;i++) {
  const {data} = await request('/api/threads/create', {key:`memory-fixture-thread-${i}`});
  assert.equal(data.runtime,'agent'); assert.ok(data.threadId && data.branchId);
  threads.push(data);
}
fs.writeFileSync(path.join(output, 'workload.json'), JSON.stringify({
  model:'none; no mocked or real model inference', fixture:{files,bytesPerFile,totalBytes:files*bytesPerFile,threads:threads.length},
  mix:['file-read-64KiB','directory-list-256-files','filename-search-Rust-directory-compute','thread-snapshot-Rust-Catalog','thread-list-Rust-Catalog','real-shell-sha256-entire-16MiB-corpus'],
  command, expectedAggregate, setup:setup.data,
  phases:[{name:'warmup',seconds:30,concurrency:4,thinkMs:250},{name:'typical',seconds:120,concurrency:4,thinkMs:500},
    {name:'high',seconds:600,concurrency:64,thinkMs:0}],
  limitations:['Representative defined local-workspace workload, not a population average or universal memory maximum.',
    'Threads have no model messages or model inference; no browser, embedding, language server, compiler, or external MCP workload.',
    'fs.exec job receipts are retained for 30 minutes by the application; output is bounded to one aggregate checksum per job.'],
},null,2));
const operations = [
  {name:'file-read',async run(i){const {data,bytes}=await request('/api/fs/read?path='+encodeURIComponent(`${corpus}/${filename(i%files)}`),undefined,true); assert.equal(sha(data),sha(contents(i%files)));return bytes;}},
  {name:'directory-list',async run(){const {data,bytes}=await request('/api/fs/list?path='+encodeURIComponent(corpus)); assert.equal(data.entries.length,files);assert.ok(data.entries.every(x=>x.isFile));return bytes;}},
  {name:'filename-search',async run(i){const name=filename(i%files);const {data,bytes}=await request('/api/find/file?'+new URLSearchParams({directory:root,query:name,limit:'20',respectGitignore:'false'})); assert.ok(Array.isArray(data)&&data.includes(`corpus/${name}`));return bytes;}},
  {name:'thread-snapshot',async run(i){const identity=threads[i%threads.length];const {data,bytes}=await request('/api/threads/snapshot',identity);assert.equal(data.identity.threadId,identity.threadId);assert.ok(Array.isArray(data.history));return bytes;}},
  {name:'thread-list',async run(){const {data,bytes}=await request('/api/threads/list',{});assert.ok(Array.isArray(data)&&threads.every(t=>data.some(x=>x.thread_id===t.threadId)));return bytes;}},
  {name:'shell-checksum',async run(){const {data,bytes}=await request('/api/fs/exec',{commands:[command],cwd:root,background:false});assert.equal(data.status,'done');assert.equal(data.success,true);assert.equal(data.results.length,1);const r=data.results[0];assert.equal(r.success,true);assert.equal(r.exitCode,0);assert.equal(r.stdout.trim(),`${expectedAggregate}  -`);assert.equal(r.stderr,'');return bytes;}},
];
// Fail on an invalid route/fixture before recording any load phase as successful.
for(let i=0;i<operations.length;i++) {await operations[i].run(i);console.log(`Validated ${operations[i].name}`);}
const reports=[];
let failures=0;
function setPhase(name){const temp=path.join(output,'phase.next');fs.writeFileSync(temp,name);fs.renameSync(temp,path.join(output,'phase'));}
function aggregate(values){values.sort((a,b)=>a-b);return {count:values.length,p50:values[Math.floor(values.length*.5)]??null,p95:values[Math.floor(values.length*.95)]??null,max:values.at(-1)??null};}
async function phase(name,seconds,concurrency,thinkMs){
  setPhase(name);
  const started=performance.now(), startUnixMs=Date.now(), deadline=started+seconds*1000;
  const stats=Object.fromEntries(operations.map(op=>[op.name,{success:0,errors:0,responseBytes:0,latencyMs:[],errorExamples:[]} ]));
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{
    let iteration=worker;
    while(performance.now()<deadline && failures<10){
      const op=operations[iteration%operations.length], record=stats[op.name], begin=performance.now();
      try{record.responseBytes+=await op.run(iteration);record.success++;}
      catch(error){record.errors++;failures++;if(record.errorExamples.length<3)record.errorExamples.push(String(error));}
      record.latencyMs.push(performance.now()-begin);
      iteration++;
      if(thinkMs)await delay(thinkMs);
    }
  }));
  const durationSeconds=(performance.now()-started)/1000;
  for(const stat of Object.values(stats))stat.latencyMs=aggregate(stat.latencyMs);
  const success=Object.values(stats).reduce((sum,x)=>sum+x.success,0),errors=Object.values(stats).reduce((sum,x)=>sum+x.errors,0);
  const report={name,startUnixMs,endUnixMs:Date.now(),targetSeconds:seconds,durationSeconds,concurrency,thinkMs,success,errors,requestsPerSecond:success/durationSeconds,operations:stats};
  reports.push(report);fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(reports,null,2));console.log(JSON.stringify(report));
  assert.equal(errors,0,`${name} had failed requests; inspect requests.json`);
}
await phase('warmup',30,4,250);
await phase('typical',120,4,500);
await phase('high',600,64,0);
