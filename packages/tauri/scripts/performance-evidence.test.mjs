import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyPerformanceEvidence} from './performance-evidence.mjs';
import {performanceFixture} from './test-fixtures/performance.mjs';
const binding={target:'linux-x64',sourceSha:'a'.repeat(40),version:'1.2.3',runtimeManifestSha256:'a'.repeat(64),engineManifestSha256:'b'.repeat(64),artifacts:{'test.AppImage':'c'.repeat(64)}};
test('performance qualification consumes same-input whole-tree A/B observations for every design scenario',()=>{
 const document=performanceFixture(binding);assert.equal(verifyPerformanceEvidence(document,binding),document);
 for(const change of [
  d=>d.scenarios.pop(),d=>d.measurement.scope='main-process-only',d=>d.measurement.memoryMetric='sum-rss-with-duplicate-shared-pages',
  d=>d.scenarios[0].tauri.inputs={...d.scenarios[0].inputs,frontendSha256:'f'.repeat(64)},
  d=>d.scenarios[0].electron.samples=[],d=>d.scenarios[0].tauri.artifactSha256='f'.repeat(64),
  d=>d.scenarios[0].tauri.samples[1].monotonicMs=0,
  d=>d.scenarios[1].tauri.samples.forEach(s=>s.frameTimesMs=[]),d=>d.scenarios[0].assessment.accepted=false,
 ]){const altered=structuredClone(document);change(altered);assert.throws(()=>verifyPerformanceEvidence(altered,binding));}
});
