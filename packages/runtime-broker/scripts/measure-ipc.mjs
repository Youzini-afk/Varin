// Run after building @varin/protocol:
// node packages/runtime-broker/scripts/measure-ipc.mjs [event-counts: 256,2048]
// Synthetic fixtures only. All measured batches use the real Node JSON IPC channel.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { decodeEnvelope, validateEnvelope } from '@varin/protocol';

function workerMain() {
 const send = envelope => new Promise((resolve, reject) => process.send(envelope, error => error ? reject(error) : resolve()));
 process.on('message', async ({count,deltaBytes}) => {
  const unit = 'x'.repeat(deltaBytes);
  let prefix = '';
  for(let seq=0;seq<count;seq++){
   prefix += unit;
   await send({v:1,kind:'event',seq,event:'agent.event',data:{
    sessionId:'fixture-session',event:{type:'message_update',runId:'fixture-run',
     message:{role:'assistant',api:'fixture-api',provider:'fixture-provider',model:'fixture-model',
      content:[{type:'text',text:prefix}],stopReason:'pending',timestamp:1,
      usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}},
     update:{type:'text_delta',contentIndex:0,delta:unit}}}});
  }
  await send({fixtureDone:true});
 });
 process.send({fixtureReady:true});
}
const workerCode = '(' + workerMain.toString() + ')()';
const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', workerCode], {
  serialization:'json', stdio:['ignore','ignore','pipe','ipc'], windowsHide:true,
});
let childFailure;
child.stderr.on('data', chunk => { childFailure = String(chunk); });
await new Promise((resolve,reject) => {
  child.once('error', reject);
  child.once('message', value => value.fixtureReady ? resolve() : reject(new Error('invalid fixture ready')));
});
const rows=[];
const run = (mode,count,deltaBytes) => new Promise((resolve,reject) => {
  const cpuStart=process.cpuUsage();
  const began=performance.now();
  let received=0, sum=0, chars=0;
  const timings=[];
  const messageHandler = value => {
   if(value.fixtureDone){
    child.off('message',messageHandler);
    const cpu=process.cpuUsage(cpuStart);
    assert.equal(received, count);
    assert.equal(chars, count * (count + 1) * deltaBytes / 2);
    timings.sort((a,b)=>a-b);
    resolve({mode,count,deltaBytes,finalTextBytes:count*deltaBytes,received,chars,
      elapsedMs:performance.now()-began,cpuMs:(cpu.user+cpu.system)/1000,
      receiverValidationMs:sum,receiverValidationP95Ms:timings[Math.floor(timings.length*.95)]});
    return;
   }
   const now=performance.now();
   const envelope=mode==='roundtrip'?decodeEnvelope(JSON.stringify(value)):validateEnvelope(value);
   const took=performance.now()-now;
   timings.push(took);sum+=took;
   if(envelope.seq!==received){reject(new Error('sequence mismatch'));return;}
   received++;
   chars+=envelope.data.event.message.content[0].text.length;
  };
  child.on('message',messageHandler);
  child.send({count,deltaBytes}, e=>{if(e)reject(e);});
});
try {
 await run('roundtrip',128,32);
 await run('validated',128,32);
 const counts = process.argv[2]?.split(',').map(Number) ?? [256, 2048];
 assert.ok(counts.every((count) => Number.isSafeInteger(count) && count > 0));
 for(const count of counts){
  for(let trial=0;trial<3;trial++){
   const modes=trial%2===0?['roundtrip','validated']:['validated','roundtrip'];
   for(const mode of modes) rows.push({trial:trial+1,...await run(mode,count,32)});
  }
 }
 const median = (values) => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const summaries = counts.map(count => {
  const aggregate = mode => {
   const samples=rows.filter(row=>row.count===count&&row.mode===mode);
   return {elapsedMs:median(samples.map(row=>row.elapsedMs)),receiverValidationMs:median(samples.map(row=>row.receiverValidationMs))};
  };
  const before=aggregate('roundtrip'),after=aggregate('validated');
  return {count,deltaBytes:32,finalTextBytes:count*32,before,after,elapsedReductionPercent:100*(1-after.elapsedMs/before.elapsedMs)};
 });
 console.log(JSON.stringify({runtime:process.version,platform:process.platform,serialization:'json',description:'Real Node IPC; cumulative full assistant prefix + 32-byte delta; compares the prior roundtrip with built protocol validateEnvelope; excludes Varin app, provider and UI timings',summaries,rows},null,2));
} finally {
 if(child.exitCode===null&&child.signalCode===null){
  const exited=once(child,'exit');
  child.kill();
  await exited;
 }
 if(childFailure) console.error(childFailure);
}
