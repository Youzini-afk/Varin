import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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


test('the required Source quality gate accepts only complete applicable results', () => {
  const gate = workflow.jobs['source-quality'].steps[0];
  const complete = {
    'needs.changes.result': 'success',
    'needs.changes.outputs.code': 'true',
    'needs.portable-source.result': 'success',
    'needs.native-build.result': 'success',
    'needs.linux-native.result': 'success',
  };
  const docs = { ...complete, 'needs.changes.outputs.code': 'false',
    'needs.native-build.result': 'skipped', 'needs.linux-native.result': 'skipped' };
  const cases = [
    ['code succeeds', complete, true],
    ['documentation only succeeds', docs, true],
    ['missing change surface', { ...complete, 'needs.changes.outputs.code': '' }, false],
    ['invalid change surface', { ...complete, 'needs.changes.outputs.code': 'unknown' }, false],
    ['documentation still requires portable checks', { ...docs, 'needs.portable-source.result': 'failure' }, false],
    ['documentation cannot hide a native failure', { ...docs, 'needs.linux-native.result': 'failure' }, false],
  ];
  for (const dependency of ['changes', 'portable-source', 'native-build', 'linux-native']) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      cases.push([`${dependency}: ${result || 'missing'}`, { ...complete, [`needs.${dependency}.result`]: result }, false]);
    }
  }
  for (const [name, values, accepted] of cases) {
    const env = Object.fromEntries(Object.entries(gate.env).map(([key, expression]) => {
      const reference = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(expression)?.[1];
      assert.ok(Object.hasOwn(values, reference), `Unknown gate input ${expression}`);
      return [key, values[reference]];
    }));
    const result = spawnSync('bash', ['--noprofile', '--norc'], {
      input: gate.run, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, accepted, `${name}: ${result.stderr}`);
  }
});
