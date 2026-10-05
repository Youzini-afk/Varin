import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createReplayRun,
  loadReplayManifest,
  recordReplayRun,
  summarizeReplayRuns,
  validateReplayManifest,
} from './harness-replay.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('the checked-in replay manifest resolves real historical tasks', () => {
  const manifest = loadReplayManifest();
  assert.ok(manifest.cases.length > 0);
  assert.deepEqual(validateReplayManifest(manifest, repoRoot), []);
});

test('run records are non-overwriting and pair into the three designed metrics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-harness-replay-'));
  try {
    const manifest = loadReplayManifest();
    const nativeDir = path.join(root, 'native');
    const harnessDir = path.join(root, 'harness');
    const native = createReplayRun({ manifest, caseId: manifest.cases[0].id, variant: 'native', model: 'test/model', pairId: 'trial-1', output: nativeDir });
    const harness = createReplayRun({ manifest, caseId: manifest.cases[0].id, variant: 'harness-shadow', model: 'test/model', pairId: 'trial-1', output: harnessDir });
    assert.throws(() => createReplayRun({ manifest, caseId: manifest.cases[0].id, variant: 'native', model: 'test/model', pairId: 'trial-1', output: nativeDir }), /already exists/);
    recordReplayRun(native.file, { success: 'pass', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, interventions: 2 });
    recordReplayRun(harness.file, { success: 'pass', inputTokens: 90, outputTokens: 15, cacheReadTokens: 50, interventions: 1 });
    assert.deepEqual(summarizeReplayRuns(root), [{
      caseId: manifest.cases[0].id,
      model: 'test/model',
      pairId: 'trial-1',
      native: { success: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 150, interventions: 2 },
      harnessShadow: { success: true, inputTokens: 90, outputTokens: 15, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 155, interventions: 1 },
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed runs require a diagnostic category', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-harness-replay-'));
  try {
    const manifest = loadReplayManifest();
    const run = createReplayRun({ manifest, caseId: manifest.cases[0].id, variant: 'native', model: 'test/model', pairId: 'trial-1', output: path.join(root, 'run') });
    assert.throws(() => recordReplayRun(run.file, {
      success: 'fail', inputTokens: 1, outputTokens: 1, interventions: 0,
    }), /failure-category/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
