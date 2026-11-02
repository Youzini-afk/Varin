import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acceptImageRelease, assertImageReleaseTag, imagePromotionPlan } from './docker-release.mjs';

const source = 'a'.repeat(40);
const input = { eventName: 'push', ref: 'refs/tags/v1.2.3', sha: source, version: '1.2.3' };

test('tag pushes and manual tag releases share exact-source acceptance and stable aliases', () => {
  const expected = { ref: input.ref, sha: source, version: '1.2.3', aliases: ['1.2.3', '1.2', '1', 'latest', `sha-${source}`] };
  assert.deepEqual(acceptImageRelease(input), expected);
  assert.deepEqual(acceptImageRelease({ ...input, eventName: 'workflow_dispatch' }), expected);
});

test('main/manual branch/PR/mismatched version and nonexact source cannot publish', () => {
  for (const patch of [{ ref: 'refs/heads/main' }, { eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
    { eventName: 'pull_request' }, { version: '1.2.4' }, { sha: 'main' }, { sha: source.slice(0, 7) },
    { ref: 'refs/tags/v01.2.3', version: '01.2.3' }, { ref: 'refs/tags/v1.2.3-01', version: '1.2.3-01' }]) {
    assert.throws(() => acceptImageRelease({ ...input, ...patch }));
  }
});

test('prereleases cannot replace latest or stable major/minor tags', () => {
  const candidate = acceptImageRelease({ ...input, ref: 'refs/tags/v1.3.0-rc.1', version: '1.3.0-rc.1' });
  assert.deepEqual(candidate.aliases, ['1.3.0-rc.1', `sha-${source}`]);
});

test('promotion uses exactly tested digests and validates every required artifact before mutation', () => {
  const candidate = acceptImageRelease(input);
  const app = `sha256:${'b'.repeat(64)}`, slimApp = `sha256:${'c'.repeat(64)}`;
  const plan = imagePromotionPlan(candidate, { app, slimApp });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].at(-1), `ghcr.io/youzini-afk/varin@${app}`);
  assert.equal(plan[1].at(-1), `ghcr.io/youzini-afk/varin-slim@${slimApp}`);
  assert.ok(plan.flat().includes('ghcr.io/youzini-afk/varin:latest'));
  assert.ok(!plan.flat().some(argument => argument.endsWith(':main')));
  assert.equal(imagePromotionPlan(candidate, { app, slimApp, base: app, slimBase: slimApp }).length, 4);
  assert.throws(() => imagePromotionPlan(candidate, { app }));
  assert.throws(() => imagePromotionPlan(candidate, { app, slimApp, base: 'mutable:main' }));
});

test('promotion rechecks lightweight and annotated release tags and rejects a moved tag', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-image-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Image release fixture', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'candidate');
  const sha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  git('tag', 'v1.2.3');
  assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root);
  git('tag', '-d', 'v1.2.3');
  git('tag', '-a', 'v1.2.3', '-m', 'annotated release');
  assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root);
  git('commit', '--quiet', '--allow-empty', '-m', 'later');
  git('tag', '-f', 'v1.2.3');
  assert.throws(() => assertImageReleaseTag(acceptImageRelease({ ...input, sha }), root), /tag moved/);
});
