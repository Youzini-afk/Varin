import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTargets, selectNativeTargets } from './native-targets.mjs';

test('normal iteration and full qualification retain their existing native runners', () => {
  assert.deepEqual(selectNativeTargets(), nativeTargets.slice(0, 3));
  assert.deepEqual(selectNativeTargets({ full: true }), nativeTargets);
  assert.deepEqual(selectNativeTargets({ full: true, target: 'default' }), nativeTargets);
  assert.equal(new Set(nativeTargets.map(value => `${value.platform}-${value.architecture}`)).size, 6);
});
test('focused iteration selects the actual target without silently satisfying a full request', () => {
  for (const value of nativeTargets) {
    const target = `${value.platform}-${value.architecture}`;
    assert.deepEqual(selectNativeTargets({ target }), [value]);
    assert.throws(() => selectNativeTargets({ full: true, target }), /full run/u);
  }
  for (const target of ['linux', 'windows-arm64', '../runner', 'ubuntu-latest', 'win32-arm64,linux-x64']) {
    assert.throws(() => selectNativeTargets({ target }), /Unknown/u);
  }
  assert.throws(() => selectNativeTargets({ full: 'true' }), /Invalid/u);
});
