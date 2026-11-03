import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertRequiredResults, changedPaths, classifyChanges, requiredJobs, surfaces } from './ci-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const all = classifyChanges([], { full: true });

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ci-surface-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const write = (file, content = 'fixture\n') => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = file => {
    if (file) write(file);
    git('add', '-A'); git('commit', '--quiet', '-m', `Fixture ${file ?? 'change'}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  fs.appendFileSync(path.join(cwd, '.git/info/exclude'), '\n/event.json\n/output\n');
  const base = commit('README.md');
  const detect = (eventName, { before = base, pullRequestBase = base, full = false, called = false } = {}) => {
    const eventPath = path.join(cwd, 'event.json');
    const outputPath = path.join(cwd, 'output');
    fs.writeFileSync(eventPath, JSON.stringify({ before, pull_request: { base: { sha: pullRequestBase } } }));
    fs.writeFileSync(outputPath, '');
    execFileSync(process.execPath, [path.join(root, 'scripts/ci-scope.mjs')], {
      cwd, env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: '', CI_FULL: String(full), CI_CALLED: String(called) },
    });
    return Object.fromEntries(fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(line => {
      const [name, value] = line.split('='); return [name, value === 'true'];
    }));
  };
  return { cwd, git, write, commit, base, detect };
}

test('manual/scheduled qualification covers every owner even without a changed diff', t => {
  const f = fixture(t);
  for (const event of ['workflow_dispatch', 'schedule']) assert.deepEqual(f.detect(event, { before: '' }), all);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.ok(workflow.on.schedule.length > 0);
});

test('reusable release quality uses exact source and cannot recurse into container validation', t => {
  const f = fixture(t);
  const scope = f.detect('push', { full: true, called: true });
  assert.equal(scope.container, false);
  assert.equal(scope.toolbelt, false);
  for (const name of surfaces.filter(name => !['container', 'toolbelt'].includes(name))) assert.equal(scope[name], true, name);
  assert.equal(workflow.on.workflow_call.inputs.source_sha.required, true);
  assert.equal(workflow.jobs.changes.outputs.full, '${{ steps.surface.outputs.full }}');
});

test('prose and known renderer edits avoid unrelated native/platform products', t => {
  const f = fixture(t);
  f.commit('docs/guide.md'); f.commit('packages/docs/page.mdx');
  assert.equal(f.detect('pull_request').code, false);
  f.commit('packages/ui/src/components/titlebar.tsx');
  const scope = f.detect('push');
  assert.equal(scope.code, true); assert.equal(scope.frontend, true);
  for (const name of ['native', 'rust', 'windows', 'macos', 'production', 'container', 'full']) assert.equal(scope[name], false, name);
});

test('owner/dependency/build input decisions include the actual downstream boundaries', () => {
  const cases = [
    ...['ui-auth.ts', 'ui-passkeys.ts'].map(owner =>
      [`packages/web/application-host/lib/ui-auth/${owner}`, ['native', 'production', 'windows', 'macos'], ['rust', 'container', 'android']]),
    ...['connections/ssh-manager.ts', 'tunnels/executable-search.ts', 'relay/host-lock.ts'].map(owner =>
      [`packages/web/application-host/lib/${owner}`, ['native', 'production', 'windows', 'macos'], []]),
    ['packages/web/cli/lib/cli-startup.ts', ['native', 'production', 'windows', 'macos'], []],
    ...['configuration-watch.ts', 'package-manager.ts', 'cloudflare-tunnel.ts'].map(helper =>
      [`packages/web/application-host/lib/${helper}`, ['native', 'production', 'windows', 'macos'], ['rust', 'android']]),
    ['packages/web/application-host/lib/mcp/sources.ts', ['native', 'production', 'windows', 'macos'], []],
    ['kernel/crates/varin-runtime/src/catalog.rs', ['native', 'rust', 'windows', 'macos', 'production', 'container'], []],
    ['packages/workspace-driver/macos/Volume.swift', ['rust', 'native', 'macos', 'container'], []],
    ['packages/mobile/android/app/build.gradle', ['frontend', 'android'], ['native', 'container']],
    ['.github/actions/android-setup/action.yml', ['android'], ['native']],
    ['packages/electron/main.ts', ['windows', 'macos', 'frontend'], ['native', 'container']],
    ['Dockerfile.base', ['container', 'toolbelt'], ['windows', 'rust']],
    ['.github/workflows/container-check.yml', ['container', 'toolbelt'], ['windows']],
    ['packages/web/package.json', surfaces, []],
    ['bun.lock', surfaces, []],
    ['scripts/build-products.mjs', surfaces, []],
    ['scripts/build-cache.mjs', surfaces, []],
    ['scripts/kernel-binary-identity.cjs', surfaces, []],
    ['tsconfig.base.json', surfaces, []],
    ['new-unclassified-owner/code.ts', surfaces, []],
    ['.github/dependabot.yml', ['code'], ['native', 'windows', 'container']],
    ['THIRD_PARTY_NOTICES.md', ['production', 'container'], []],
  ];
  for (const [file, yes, no] of cases) {
    const scope = classifyChanges([file]);
    for (const name of yes) assert.equal(scope[name], true, `${file} requires ${name}`);
    for (const name of no) assert.equal(scope[name], false, `${file} does not affect ${name}`);
  }
});

test('deletion, rename and unusual filenames cannot erase the old owner', t => {
  const f = fixture(t);
  const base = f.commit('kernel/crates/old owner\n.rs');
  f.git('mv', 'kernel/crates/old owner\n.rs', 'packages-ui-moved.ts'); f.commit();
  const paths = changedPaths({ cwd: f.cwd, eventName: 'push', event: { before: base } });
  assert.ok(paths.includes('kernel/crates/old owner\n.rs'));
  assert.equal(classifyChanges(paths).rust, true);
  const nextBase = f.git('rev-parse', 'HEAD');
  f.git('rm', 'packages-ui-moved.ts'); f.commit();
  assert.deepEqual(classifyChanges(changedPaths({ cwd: f.cwd, eventName: 'push', event: { before: nextBase } })), all);
});

test('missing/unavailable bases and mixed unknown diffs require full qualification', t => {
  const f = fixture(t);
  f.commit('packages/ui/src/feature.ts');
  assert.deepEqual(f.detect('push', { before: '0'.repeat(40) }), all);
  assert.deepEqual(f.detect('push', { before: '' }), all);
  assert.deepEqual(classifyChanges(['docs/guide.md', 'new-package/README.runtime-template.md']), all);
});

test('the always-present gate rejects every missing/failed/cancelled/unexpectedly skipped requirement', () => {
  assert.equal(workflow.jobs['source-quality'].if, '${{ always() }}');
  const expectedJobs = Object.keys(requiredJobs(all));
  assert.deepEqual(new Set(workflow.jobs['source-quality'].needs), new Set(['changes', ...expectedJobs]));
  for (const scope of [all, classifyChanges(['docs/guide.md']), classifyChanges(['packages/ui/src/file.ts'])]) {
    const needs = { changes: { result: 'success' }, ...Object.fromEntries(Object.entries(requiredJobs(scope))
      .map(([job, required]) => [job, { result: required ? 'success' : 'skipped' }])) };
    assert.doesNotThrow(() => assertRequiredResults(scope, needs));
    for (const job of ['changes', ...expectedJobs]) for (const result of ['failure', 'cancelled', 'missing', 'skipped', 'success']) {
      if (result === needs[job].result) continue;
      assert.throws(() => assertRequiredResults(scope, { ...needs, [job]: { result } }), undefined, `${job} ${result}`);
    }
    for (const job of ['changes', ...expectedJobs]) {
      const incomplete = { ...needs }; delete incomplete[job];
      assert.throws(() => assertRequiredResults(scope, incomplete));
    }
  }
  assert.throws(() => requiredJobs({ ...all, native: undefined }));
  const bad = spawnSync(process.execPath, ['scripts/ci-scope.mjs', 'gate'], { cwd: root,
    env: { ...process.env, CI_NEEDS: JSON.stringify({ changes: { result: 'success', outputs: {} } }) }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('platform discovery keeps native teardown, storage, observation and file-CAS evidence', () => {
  const discover = config => JSON.parse(execFileSync(process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json', '--config', config],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const paths = result => result.map(entry => typeof entry === 'string' ? entry : entry.file).map(file => file.replaceAll('\\', '/'));
  const native = paths(discover('packages/web/vitest.kernel.platform.config.ts'));
  for (const suffix of ['terminal/shell-integration.live.native.test.ts', 'kernel/kernel-process.native.test.ts',
    'kernel/storage-adapter.native.test.ts', 'recovery/kernel-durable-engine.native.test.ts', 'documents/watch.native.test.ts']) {
    assert.ok(native.some(file => file.endsWith(suffix)), suffix);
  }
  const portable = paths(discover('packages/web/vitest.platform.config.ts'));
  for (const suffix of ['mcp/settings.test.ts', 'connections/ssh-manager.test.ts',
    'tunnels/executable-search.test.ts', 'relay/host-lock.test.ts', 'cli/cli.test.ts']) {
    assert.ok(portable.some(file => file.endsWith(suffix)), suffix);
  }
  const commonHostTests = fs.readdirSync(path.join(root, 'packages/web/application-host/lib'))
    .filter(file => file.endsWith('.test.ts') && !file.endsWith('.native.test.ts'));
  for (const file of commonHostTests) {
    assert.ok(portable.some(found => found.endsWith(`/application-host/lib/${file}`)), file);
  }
  assert.ok(portable.every(file => !file.endsWith('.native.test.ts')));
});


test('release automation can build an older source without borrowing its tool setup', () => {
  const release = parse(fs.readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'));
  const steps = release.jobs.android.steps;
  const source = steps.find(step => step.uses?.startsWith('actions/checkout@') && !step.with.path);
  assert.equal(source.with.ref, '${{ needs.prepare.outputs.sha }}');
  const setup = steps.find(step => step.uses?.endsWith('/.github/actions/android-setup'));
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@') && step.with.path
    && setup.uses.startsWith(`./${step.with.path}/`));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.ok(checkout.with['sparse-checkout'].includes('.github/actions/android-setup'));
  assert.ok(steps.indexOf(checkout) < steps.indexOf(setup));
  const native = release.jobs['native-quality'];
  assert.ok(native.steps.some(step => step.run?.includes('bun run test:rust --no-fail-fast')));
  assert.ok(release.jobs.assemble.needs.includes('native-quality'));
});

test('all heavy Dependabot lanes share one non-cancelling queue, including reusable containers', () => {
  const container = parse(fs.readFileSync(new URL('../.github/workflows/container-check.yml', import.meta.url), 'utf8'));
  for (const job of [...['portable-source', 'native-build', 'linux-native', 'windows-runtime',
    'macos-storage', 'production-build', 'android-build'].map(name => workflow.jobs[name]), container.jobs.verify]) {
    assert.ok(job.concurrency.group.includes("github.event.pull_request.user.login == 'dependabot[bot]'"));
    assert.ok(job.concurrency.group.includes("'varin-dependabot-background'"));
    assert.equal(job.concurrency.queue, 'max');
    assert.notEqual(job.concurrency['cancel-in-progress'], true);
  }
});
