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
    ...['storage/service.ts', 'kernel/source-launch.ts', 'recovery/locations.ts', 'credentials/service.ts',
      'structure/grammar-store.ts', 'language-support/runtime.ts', 'projects/project-config.ts'].map(owner =>
      [`packages/web/application-host/lib/${owner}`, ['native', 'production', 'windows', 'macos'], []]),
    ['packages/web/cli/lib/cli-startup.ts', ['native', 'production', 'windows', 'macos'], []],
    ...['configuration-watch.ts', 'package-manager.ts', 'cloudflare-tunnel.ts'].map(helper =>
      [`packages/web/application-host/lib/${helper}`, ['native', 'production', 'windows', 'macos'], ['rust', 'android']]),
    ['packages/web/application-host/lib/mcp/sources.ts', ['native', 'production', 'windows', 'macos'], []],
    ...['memory/thread-remember.ts', 'extensions/invocation-principal.ts'].map(owner =>
      [`packages/web/application-host/lib/${owner}`, ['native', 'production', 'windows', 'macos'], ['rust', 'container', 'full']]),
    ...['application-host/lib/memory/thread-remember.test.ts', 'application-host/lib/extensions/invocation-principal.test.ts',
      'application-host/lib/deadline.test.ts', 'cli/cli.test.ts'].map(owner =>
      [`packages/web/${owner}`, ['code', 'windows', 'macos'], ['native', 'rust', 'production', 'container', 'full']]),
    ['packages/web/application-host/lib/harness/experiments.test.ts', ['code'], ['native', 'production', 'windows', 'macos']],
    ...['kernel/kernel-process.native.test.ts', 'knowledge/store.smoke.test.ts', 'kernel/kernel-client.test.ts',
      'kernel/process.test-helper.ts', 'kernel/process.fixture.ts'].map(owner =>
      [`packages/web/application-host/lib/${owner}`, ['native', 'production', 'windows', 'macos'], ['rust', 'container']]),
    ['kernel/crates/varin-runtime/tests/host_job_review.rs', ['code', 'native', 'rust'], ['production', 'container', 'windows', 'macos', 'full']],
    ...['varin-runtime/tests/fixtures/input_admission.rs', 'varin-computer-windows/tests/transport.rs'].map(owner =>
      [`kernel/crates/${owner}`, ['native', 'rust', 'windows', 'macos', 'production', 'container'], []]),
    ['kernel/crates/varin-runtime/src/catalog.rs', ['native', 'rust', 'windows', 'macos', 'production', 'container'], []],
    ['packages/workspace-driver/macos/Volume.swift', ['rust', 'native', 'macos', 'container'], []],
    ['packages/mobile/android/app/build.gradle', ['frontend', 'android'], ['native', 'container']],
    ['.github/actions/android-setup/action.yml', ['android'], ['native']],
    ['packages/electron/main.ts', ['windows', 'macos', 'frontend'], ['native', 'container']],
    ['Dockerfile.base', ['container', 'toolbelt'], ['windows', 'rust']],
    ...['container-check', 'container-images', 'docker-commit'].map(name =>
      [`.github/workflows/${name}.yml`, ['container', 'toolbelt'], ['windows']]),
    ['scripts/build-container-images.mjs', ['container', 'toolbelt'], ['windows', 'rust']],
    ...['smoke-container-budget.mjs', 'smoke-container-stop.mjs'].map(helper =>
      [`scripts/${helper}`, ['container', 'toolbelt'], ['frontend', 'native', 'rust', 'production', 'windows', 'macos', 'android', 'full']]),
    ['packages/web/application-host/lib/harness/resources-system.ts', ['native', 'production', 'container'], ['frontend', 'rust', 'windows', 'macos', 'toolbelt', 'android', 'full']],
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
  const oldPath = process.platform === 'win32' ? 'kernel/crates/old owner 中文.rs' : 'kernel/crates/old owner\n.rs';
  const base = f.commit(oldPath);
  f.git('mv', oldPath, 'packages-ui-moved.ts'); f.commit();
  const paths = changedPaths({ cwd: f.cwd, eventName: 'push', event: { before: base } });
  assert.ok(paths.includes(oldPath));
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

test('test leaves accumulate mixed changes and preserve deleted or renamed owners', t => {
  const portable = 'packages/web/application-host/lib/memory/thread-remember.test.ts';
  const runtime = 'kernel/crates/varin-runtime/tests/host_job_review.rs';
  const source = 'kernel/crates/varin-runtime/src/catalog.rs';
  for (const leaf of [portable, runtime]) for (const other of [source, 'new-owner/test.test.ts']) {
    for (const files of [[leaf, other], [other, leaf]]) {
      assert.deepEqual(classifyChanges(files), classifyChanges([other]));
    }
  }
  for (const [from, to, expected] of [
    [portable, null, portable],
    ['packages/web/application-host/lib/kernel/kernel-process.native.test.ts', portable,
      'packages/web/application-host/lib/kernel/kernel-process.native.test.ts'],
    [portable, source, source],
    ['kernel/crates/varin-runtime/tests/fixtures/input_admission.rs', runtime,
      'kernel/crates/varin-runtime/tests/fixtures/input_admission.rs'],
  ]) {
    const f = fixture(t);
    const before = f.commit(from);
    if (to) { fs.mkdirSync(path.dirname(path.join(f.cwd, to)), { recursive: true }); f.git('mv', from, to); }
    else f.git('rm', from);
    f.commit();
    assert.deepEqual(f.detect('push', { before }), classifyChanges([expected]));
  }
});

test('the always-present gate rejects every missing/failed/cancelled/unexpectedly skipped requirement', () => {
  assert.equal(workflow.jobs['source-quality'].if, '${{ always() }}');
  const expectedJobs = Object.keys(requiredJobs(all));
  assert.deepEqual(new Set(workflow.jobs['source-quality'].needs), new Set(['changes', ...expectedJobs]));
  for (const scope of [all, ...['docs/guide.md', 'packages/ui/src/file.ts',
    'packages/web/application-host/lib/memory/thread-remember.ts', 'bun.lock',
    'packages/web/application-host/lib/memory/thread-remember.test.ts',
    'kernel/crates/varin-runtime/tests/host_job_review.rs'].map(file => classifyChanges([file]))]) {
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

test('Rust workspace applicability stays separate from Host-only native verification', () => {
  for (const [file, native, rust] of [
    ['docs/guide.md', false, false],
    ['packages/ui/src/file.ts', false, false],
    ['packages/web/application-host/lib/memory/thread-remember.ts', true, false],
    ['kernel/crates/varin-runtime/tests/child_dispatch_review.rs', true, true],
    ['kernel/crates/varin-runtime/tests/fixtures/child_dispatch.rs', true, true],
    ['kernel/crates/varin-runtime/src/catalog.rs', true, true],
    ['kernel/rust-toolchain.toml', true, true],
    ['bun.lock', true, true],
    ['.github/workflows/ci.yml', true, true],
  ]) {
    const required = requiredJobs(classifyChanges([file]));
    assert.equal(required['linux-native'], native, file);
    assert.equal(required['rust-workspace'], rust, file);
    if (rust) assert.equal(required['native-build'], true, file);
  }
  assert.equal(requiredJobs(all)['rust-workspace'], true);
  assert.equal(requiredJobs(classifyChanges([], { full: true, called: true }))['rust-workspace'], true);
});

test('independent Linux lanes restore the same kernel and retain their real runtime prerequisites', () => {
  const producer = workflow.jobs['native-build'];
  const artifact = producer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with.name;
  const native = workflow.jobs['linux-native'];
  const rust = workflow.jobs['rust-workspace'];
  const prerequisite = "${{ !cancelled() && steps.native-restore.outcome == 'success' && steps.prepare.outcome == 'success' }}";
  for (const [job, surface] of [[native, 'native'], [rust, 'rust']]) {
    assert.deepEqual(job.needs, ['changes', 'native-build']);
    assert.equal(job.if, `\${{ !cancelled() && needs.changes.outputs.${surface} == 'true' && needs.native-build.result == 'success' }}`);
    assert.equal(job['runs-on'], producer['runs-on']);
    const steps = job.steps;
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ inputs.source_sha || github.sha }}');
    assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 24);
    assert.equal(steps.find(step => step.uses === './.github/actions/setup-bun').with['bun-version'], '1.3.14');
    const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, artifact);
    assert.equal(download.with.path, '.build-input/kernel');
    assert.equal(job.env.VARIN_KERNEL_ARTIFACT, '${{ github.workspace }}/.build-input/kernel');
    assert.equal(job.env.VARIN_TEST_KERNEL_PATH, '${{ github.workspace }}/artifacts/build/kernel-linux-x64/varin-kernel');
    assert.equal(job.env.VARIN_KERNEL_PATH, job.env.VARIN_TEST_KERNEL_PATH);
    const restore = steps.find(step => step.id === 'native-restore');
    assert.equal(restore.run, 'node scripts/build-products.mjs kernel');
    assert.ok(steps.indexOf(download) < steps.indexOf(restore));
    const dependencies = steps.find(step => step.id === 'dependencies');
    assert.equal(dependencies.run, 'bun install --frozen-lockfile');
    const prepare = steps.find(step => step.id === 'prepare');
    assert.equal(prepare.run, 'bun run build:type-dependencies');
    assert.equal(prepare.if, "${{ !cancelled() && steps.dependencies.outcome == 'success' }}");
    assert.ok(steps.indexOf(dependencies) < steps.indexOf(prepare));
    const fuse = steps.find(step => step.name?.startsWith('Prepare FUSE'));
    assert.equal(fuse.if, prerequisite);
    assert.deepEqual(fuse.run.trim().split('\n'), ['sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends fuse3', 'sudo modprobe fuse', 'test -c /dev/fuse']);
    assert.ok(steps.indexOf(restore) < steps.indexOf(fuse));
    assert.ok(steps.indexOf(prepare) < steps.indexOf(fuse));
    assert.ok(steps.every(step => !step['continue-on-error']));
  }
  assert.notEqual(native.concurrency.group, rust.concurrency.group);
  assert.ok(native.concurrency.group.includes("format('varin-ci-native-{0}', github.run_id)"));
  assert.ok(rust.concurrency.group.includes("format('varin-ci-rust-{0}', github.run_id)"));
  const authority = native.steps.find(step => step.run === 'node scripts/test-kernel-authority.mjs');
  assert.equal(authority.if, prerequisite);
  assert.ok(native.steps.indexOf(authority) > native.steps.findIndex(step => step.name?.startsWith('Prepare FUSE')));
  assert.ok(!rust.steps.some(step => step.run?.includes('test-kernel-authority.mjs')));
  assert.ok(!native.steps.some(step => step.run?.includes('test:rust') || step.id === 'rust-cache'));
});

test('Rust lane keeps compilation, FUSE coverage, execution budget and failed-test cache preservation', () => {
  const steps = workflow.jobs['rust-workspace'].steps;
  const build = steps.find(step => step.id === 'rust-build');
  assert.equal(build.run, 'bun run test:rust --no-run');
  assert.equal(build.if, "${{ !cancelled() && needs.changes.outputs.rust == 'true' && steps.native-restore.outcome == 'success' && steps.prepare.outcome == 'success' }}");
  assert.ok(steps.indexOf(build) > steps.findIndex(step => step.name?.startsWith('Prepare FUSE')));
  const compiled = "${{ !cancelled() && needs.changes.outputs.rust == 'true' && steps.rust-build.outcome == 'success' }}";
  const nativeFuse = steps.find(step => step.name === 'Compile native FUSE workspace adapter');
  const libfuse = steps.find(step => step.name === 'Compile public libfuse3 mount transport');
  for (const step of [nativeFuse, libfuse]) {
    assert.equal(step.if, compiled);
    assert.equal(step['working-directory'], 'kernel');
    assert.ok(steps.indexOf(build) < steps.indexOf(step));
  }
  assert.equal(nativeFuse.run, 'cargo check -p varin-kernel --all-targets --features workspace-mount --locked');
  assert.deepEqual(libfuse.run.trim().split('\n'), ['sudo apt-get update',
    'sudo apt-get install -y --no-install-recommends libfuse3-dev',
    'cargo check -p varin-kernel --lib --features workspace-mount,fuser/libfuse3 --locked']);
  const execution = steps.find(step => step.name === 'Test Rust workspace');
  assert.equal(execution.if, compiled);
  assert.equal(execution.run, 'bun run test:rust --no-fail-fast');
  assert.equal(execution['timeout-minutes'], 10);
  assert.equal(execution.env.VARIN_TEST_KERNEL_EXECUTABLE, workflow.jobs['rust-workspace'].env.VARIN_TEST_KERNEL_PATH);
  assert.equal(execution.env.RUST_BACKTRACE, 1);
  assert.ok(steps.indexOf(libfuse) < steps.indexOf(execution));
  const restore = steps.find(step => step.id === 'rust-cache');
  assert.ok(restore.with.key.startsWith('rust-tests-${{ runner.os }}-${{ runner.arch }}-'));
  assert.equal(restore.with['restore-keys'], "rust-tests-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('kernel/rust-toolchain.toml', 'kernel/Cargo.lock') }}-");
  assert.deepEqual(restore.with.path.trim().split('\n'), ['~/.cargo/registry', '~/.cargo/git', 'kernel/target/debug']);
  assert.ok(steps.indexOf(restore) < steps.indexOf(build));
  const save = steps.find(step => step.uses?.startsWith('actions/cache/save@'));
  assert.equal(save.if, "${{ !cancelled() && steps.rust-build.outcome == 'success' && steps.rust-cache.outputs.cache-hit != 'true' }}");
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, '${{ steps.rust-cache.outputs.cache-primary-key }}');
  assert.ok(steps.indexOf(execution) < steps.indexOf(save));
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
    'tunnels/executable-search.test.ts', 'relay/host-lock.test.ts', 'memory/thread-remember.test.ts', 'cli/cli.test.ts',
    'extensions/invocation-principal.test.ts',
    'storage/service.test.ts', 'kernel/source-launch.test.ts', 'recovery/locations.test.ts', 'credentials/service.test.ts',
    'structure/grammar-store.test.ts', 'language-support/runtime.test.ts', 'projects/project-config.test.ts']) {
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
  const setupPath = setup.uses.slice(`./${checkout.with.path}/`.length);
  assert.ok(checkout.with['sparse-checkout'].trim().split('\n').some(directory =>
    setupPath === directory || setupPath.startsWith(`${directory}/`)));
  assert.ok(steps.indexOf(checkout) < steps.indexOf(setup));
  const build = release.jobs['native-build'];
  assert.equal(build['runs-on'], 'ubuntu-22.04');
  const glibcCheck = build.steps.find(step => step.run?.includes('check-linux-glibc.mjs'));
  const tooling = build.steps.find(step => step.with?.path === '.release-automation');
  assert.equal(tooling.with.ref, '${{ github.sha }}');
  assert.ok(glibcCheck.run.includes('.release-automation/scripts/check-linux-glibc.mjs'));
  assert.ok(build.steps.indexOf(tooling) < build.steps.indexOf(glibcCheck));
  const native = release.jobs['native-quality'];
  assert.ok(native.steps.some(step => step.run?.includes('bun run test:rust --no-fail-fast')));
  assert.ok(release.jobs.assemble.needs.includes('native-quality'));
});

test('all heavy Dependabot lanes share one non-cancelling queue, including reusable containers', () => {
  const container = parse(fs.readFileSync(new URL('../.github/workflows/container-check.yml', import.meta.url), 'utf8'));
  for (const job of [...['portable-source', 'native-build', 'linux-native', 'rust-workspace', 'windows-runtime',
    'macos-storage', 'production-build', 'android-build'].map(name => workflow.jobs[name]), container.jobs.verify]) {
    assert.ok(job.concurrency.group.includes("github.event.pull_request.user.login == 'dependabot[bot]'"));
    assert.ok(job.concurrency.group.includes("'varin-dependabot-background'"));
    assert.equal(job.concurrency.queue, 'max');
    assert.notEqual(job.concurrency['cancel-in-progress'], true);
  }
});
