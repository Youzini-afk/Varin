import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Use the workspace's declared YAML dependency, including isolated Bun installs.
const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const surface = workflow.jobs.changes.steps.find(step => step.id === 'surface');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ci-surface-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8' }).trim();
  const write = file => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture\n');
  };
  const commit = file => {
    write(file);
    git('add', file);
    git('commit', '--quiet', '-m', `Add ${file}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  const base = commit('README.md');
  const detect = (eventName, { before = base, pullRequestBase = base } = {}) => {
    const values = {
      'github.event_name': eventName,
      'github.event.before': before,
      'github.event.pull_request.base.sha': pullRequestBase,
    };
    const script = surface.run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
      assert.ok(Object.hasOwn(values, expression), `Unexpected workflow expression: ${expression}`);
      return values[expression];
    });
    const output = path.join(root, 'github-output');
    fs.writeFileSync(output, '');
    execFileSync('bash', ['--noprofile', '--norc'], {
      cwd: root,
      input: script,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
  };
  return { commit, detect };
}

test('manual CI is dispatchable and validates all surfaces even for an unchanged candidate', t => {
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  const f = fixture(t);
  assert.deepEqual(f.detect('workflow_dispatch'), { code: 'true', rust: 'true' });
  f.commit('docs/guide.md');
  assert.deepEqual(f.detect('workflow_dispatch'), { code: 'true', rust: 'true' });
  assert.deepEqual(f.detect('workflow_dispatch', { before: '' }), { code: 'true', rust: 'true' });
});

test('documentation-only pushes and pull requests retain lightweight CI', t => {
  const f = fixture(t);
  f.commit('docs/guide.md');
  f.commit('packages/docs/page.mdx');
  assert.deepEqual(f.detect('push'), { code: 'false', rust: 'false' });
  assert.deepEqual(f.detect('pull_request', { before: '' }), { code: 'false', rust: 'false' });
});

test('ordinary code changes enable package checks without rebuilding Rust tests', t => {
  const f = fixture(t);
  f.commit('packages/web/application-host/feature.ts');
  assert.deepEqual(f.detect('push'), { code: 'true', rust: 'false' });
});

test('Rust pull requests compare against the PR base and enable both surfaces', t => {
  const f = fixture(t);
  const head = f.commit('kernel/crates/runtime/src/lib.rs');
  assert.deepEqual(f.detect('pull_request', { before: head }), { code: 'true', rust: 'true' });
});

test('CI workflow changes and unavailable push bases require full validation', t => {
  const f = fixture(t);
  f.commit('.github/workflows/ci.yml');
  assert.deepEqual(f.detect('push'), { code: 'true', rust: 'true' });
  assert.deepEqual(f.detect('push', { before: '0'.repeat(40) }), { code: 'true', rust: 'true' });
});
