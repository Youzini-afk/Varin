import { performanceScenarios } from '../performance-evidence.mjs';
// Synthetic verifier input only. Never actual product performance observations.
export function performanceFixture({target,sourceSha,version,runtimeManifestSha256,engineManifestSha256,artifacts}) {
 const inputs={frontendSha256:'a'.repeat(64),dataSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)};
 return {schema:1,product:'varin-desktop-performance',target,sourceSha,version,runtimeManifestSha256,engineManifestSha256,artifacts,
  environment:{os:'synthetic',osVersion:'fixture',cpu:'fixture',gpu:'fixture',display:'fixture',logicalCpus:1,memoryBytes:1024},
  measurement:{collector:'synthetic-unit-fixture',version:'1',clock:'monotonic',scope:'all-owned-desktop-processes',memoryMetric:'private-bytes',gpuAccounting:'synthetic test only',intervalMs:100},
  scenarios:performanceScenarios.map(name=>({name,scenarioSha256:'d'.repeat(64),inputs,
   ...Object.fromEntries(['electron','tauri'].map(shell=>[shell,{shell,sourceSha,version,artifactSha256:shell==='tauri'?Object.values(artifacts)[0]:'e'.repeat(64),inputs,rootPid:123,startupMs:10,
    samples:[0,100].map(monotonicMs=>({monotonicMs,gpuBytes:10,processes:[{pid:123,parentPid:1,role:'shell',cpuTimeMs:10,memoryBytes:10,handles:2,startIdentity:'fixture'}],frameTimesMs:[16],inputLatenciesMs:[12]}))}])),
   assessment:{method:'synthetic unit fixture',result:'not a real performance result',accepted:true}}))};
}
