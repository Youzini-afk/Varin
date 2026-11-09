import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// These are product/owner boundaries, not a second package dependency graph.
// Unknown inputs deliberately select the complete qualification path.
export const surfaces = ['code', 'frontend', 'native', 'rust', 'windows', 'macos',
  'production', 'container', 'toolbelt', 'android', 'security', 'full'];
const empty = () => Object.fromEntries(surfaces.map(name => [name, false]));
const all = () => Object.fromEntries(surfaces.map(name => [name, true]));
const prose = /(?:^docs\/|^packages\/docs\/|^\.github\/readme\/|(?:^|\/)(?:README(?:\.[a-z]{2}(?:-[A-Z]{2})?)?|DOCUMENTATION|AGENTS|CHANGELOG)\.md$)/u;
const hostPlatform = /^packages\/web\/application-host\/(?:index\.ts|lib\/(?:[^/]+$|(?:kernel|storage|recovery|documents|fs|process|terminal|workspace|git|github|mcp|extensions|platform|knowledge|memory|lsp|computer|external-agents|agent-resources|service-credentials|credentials|client-auth|ui-auth|connections|tunnels|relay|structure|language-support|projects)\/))/u;

export function classifyChanges(files, { full = false, called = false, qualification = 'all' } = {}) {
  if (!['all', 'container'].includes(qualification) || (qualification === 'container' && !called)) {
    throw new Error('Container qualification requires an explicit reusable CI caller');
  }
  const result = full || files === null ? all() : empty();
  const enable = (...names) => { for (const name of names) result[name] = true; };
  if (!full && files !== null) for (const file of files) {
    if (prose.test(file)) continue;
    enable('code');
    if (file === '.github/dependabot.yml' || file === '.github/renovate.json'
      || /^\.github\/(?:ISSUE_TEMPLATE\/|(?:CODE_OF_CONDUCT|CONTRIBUTING|SECURITY|SUPPORT|pull_request_template)\.md$)/u.test(file)) continue;
    // A workspace manifest or lock can change native ABI/transitive dependencies.
    if (/(?:^|\/)package\.json$/u.test(file) || /^(?:bun\.lock|bun-patches\/|patches\/)/u.test(file)) {
      Object.assign(result, all()); continue;
    }
    if (/^(?:Dockerfile(?:\.base)?$|\.dockerignore$|docker-compose(?:\.toolbelt)?\.yml$|\.github\/workflows\/(?:docker(?:-commit)?|container-(?:check|images))\.yml$|scripts\/(?:docker-|build-container-images))/u.test(file)) {
      enable('container', 'toolbelt'); continue;
    }
    if (file === 'scripts/smoke-container-budget.mjs' || file === 'scripts/smoke-container-stop.mjs') {
      enable('container', 'toolbelt'); continue;
    }
    if (/^packages\/(?:ui\/|web\/(?:src\/|public\/|(?:index|mobile|mini-chat|companion)\.html$|vite\.config\.ts$|postcss\.config\.js$))/u.test(file)) {
      enable('frontend'); continue;
    }
    if (/^packages\/mobile\//u.test(file) || file.startsWith('.github/actions/android-setup/')) {
      enable('frontend', 'android'); continue;
    }
    if (file.startsWith('packages/electron/')) {
      enable('frontend', 'windows', 'macos'); continue;
    }
    if (file.startsWith('packages/computer-driver/')) {
      enable('production');
      if (file.startsWith('packages/computer-driver/windows/')) enable('windows');
      else if (file.startsWith('packages/computer-driver/macos/')) enable('macos');
      else if (!file.startsWith('packages/computer-driver/linux/')) enable('windows', 'macos');
      continue;
    }
    // Cargo discovers these integration leaves only for tests. Nested fixtures
    // can be compiled into other owners and retain the ordinary kernel scope.
    if (/^kernel\/crates\/varin-runtime\/tests\/[^/]+\.rs$/u.test(file)) {
      enable('native', 'rust'); continue;
    }
    if (file.startsWith('kernel/') || file.startsWith('packages/workspace-driver/')) {
      enable('native', 'rust', 'windows', 'macos', 'production', 'container');
      if (/(?:Cargo\.(?:toml|lock)|rust-toolchain\.toml)$/u.test(file)) enable('security');
      continue;
    }
    if (file.startsWith('packages/web/application-host/') || file.startsWith('packages/web/cli/')) {
      // Portable test leaves are excluded from production output. Keep the
      // dedicated native/Node entries and shared helpers on their owner scope.
      const portableTest = file.endsWith('.test.ts') && !/\.(?:native|smoke)\.test\.ts$/u.test(file)
        && !file.endsWith('/lib/kernel/kernel-client.test.ts');
      if (!portableTest) enable('native', 'production');
      if (file === 'packages/web/application-host/lib/harness/resources-system.ts') enable('container');
      if (hostPlatform.test(file) || file.startsWith('packages/web/cli/')) enable('windows', 'macos');
      continue;
    }
    if (/^packages\/(?:application-client|protocol|settings-store|script-runtime|extension-[^/]+)\//u.test(file)) {
      enable('frontend', 'native', 'production');
      if (!file.startsWith('packages/application-client/')) enable('windows', 'macos');
      continue;
    }
    if (/^(?:LICENSE|THIRD_PARTY_NOTICES\.md)$/u.test(file)) {
      enable('production', 'container'); continue;
    }
    // Build/config/workflow inputs are intentionally not an optimistic allowlist.
    Object.assign(result, all());
  }
  // The release caller validates its actual images after this source/native gate.
  // A reusable CI invocation never recursively calls the container workflow.
  if (called) { result.container = false; result.toolbelt = false; }
  // Linux image publication owns Linux/native/production qualification. Desktop
  // and Android evidence remains mandatory in ordinary complete qualification.
  if (qualification === 'container') {
    result.windows = false; result.macos = false; result.android = false;
  }
  return result;
}

export function changedPaths({ cwd = process.cwd(), eventName, event }) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  if (!base) return null;
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
    // --no-renames gives both sides of a move: moving native code into a new
    // frontend path must not lose the old owner's required checks.
    return git(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
  } catch { return null; }
}

export function requiredJobs(scope) {
  if (surfaces.some(name => typeof scope[name] !== 'boolean')) throw new Error('Missing or invalid CI surface');
  return {
    'portable-source': true,
    'production-preflight': scope.code,
    'native-build': scope.native || scope.production,
    'linux-native': scope.native,
    'rust-workspace': scope.rust,
    'windows-runtime': scope.windows,
    'windows-native-build': scope.windows && scope.native,
    'windows-native': scope.windows && scope.native,
    'windows-workspace': scope.windows && scope.rust,
    'macos-storage': scope.macos,
    'production-build': scope.production,
    'container-check': scope.container,
    'android-build': scope.android,
  };
}

export function assertRequiredResults(scope, needs) {
  if (needs.changes?.result !== 'success') throw new Error('Change detection did not succeed');
  for (const [job, required] of Object.entries(requiredJobs(scope))) {
    const expected = required ? 'success' : 'skipped';
    if (needs[job]?.result !== expected) throw new Error(`${job}: expected ${expected}, received ${needs[job]?.result ?? 'missing'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'gate') {
    const needs = JSON.parse(process.env.CI_NEEDS);
    const scope = Object.fromEntries(surfaces.map(name => {
      const value = needs.changes?.outputs?.[name];
      if (value !== 'true' && value !== 'false') throw new Error(`Missing or invalid CI surface: ${name}`);
      return [name, value === 'true'];
    }));
    assertRequiredResults(scope, needs);
    console.log('Every applicable source, native, platform and product check passed.');
  } else {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const full = process.env.CI_FULL === 'true' || ['workflow_dispatch', 'schedule'].includes(eventName);
    const scope = classifyChanges(full ? [] : changedPaths({ eventName, event }), {
      full, called: process.env.CI_CALLED === 'true', qualification: process.env.CI_QUALIFICATION || 'all',
    });
    for (const [name, value] of Object.entries(scope)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    const summary = Object.entries(requiredJobs(scope)).map(([job, required]) => `- ${job}: ${required ? 'required' : 'not affected'}`).join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Applicable CI checks\n${summary}\n`);
  }
}
