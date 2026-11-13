import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
test('native semantic matching, state dispatch and read cancellation ownership', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'varin-ax-tests-'));
  try {
    copyFileSync(join(source, 'tests', 'semantic.swift'), join(directory, 'main.swift'));
    const executable = join(directory, 'semantic-tests');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5',
      ...['Native.swift', 'Accessibility.swift', 'SemanticActions.swift'].map(name => join(source, name)),
      join(directory, 'main.swift'), '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
      '-o', executable], { stdio: 'pipe' });
    assert.match(execFileSync(executable, [], { encoding: 'utf8' }), /semantic state tests passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
