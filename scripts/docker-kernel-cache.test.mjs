import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const kernel = fileURLToPath(new URL('../kernel/', import.meta.url));
const chefAvailable = spawnSync('cargo', ['chef', '--version'], { cwd: kernel, stdio: 'ignore' }).status === 0;

test('real Cargo recipe separates source changes from dependencies and restores the patched workspace', {
  skip: !chefAvailable && 'Pinned cargo-chef is unavailable; Docker CI exercises the actual cook and build',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-kernel-cache-'));
  const source = path.join(root, 'source');
  const cooked = path.join(root, 'cooked');
  const recipe = path.join(root, 'recipe.json');
  const run = (cwd, ...args) => execFileSync('cargo', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.cpSync(kernel, source, { recursive: true, filter: name => path.basename(name) !== 'target' });
    run(source, 'chef', 'prepare', '--recipe-path', recipe);
    const original = fs.readFileSync(recipe, 'utf8');
    fs.appendFileSync(path.join(source, 'crates/varin-kernel/src/main.rs'), '\n// A source-only edit must retain dependency cache identity.\n');
    run(source, 'chef', 'prepare', '--recipe-path', recipe);
    assert.equal(fs.readFileSync(recipe, 'utf8'), original);

    fs.mkdirSync(cooked);
    // Excluded path dependencies are deliberately supplied separately, just as
    // in the Docker dependencies stage. They are not workspace dummy crates.
    fs.cpSync(path.join(source, 'vendor'), path.join(cooked, 'vendor'), { recursive: true });
    run(cooked, 'chef', 'cook', '--recipe-path', recipe, '--release', '--bin', 'varin-kernel', '--locked', '--target', 'x86_64-unknown-linux-gnu', '--no-build');
    const metadata = JSON.parse(run(cooked, 'metadata', '--format-version', '1', '--locked', '--no-deps'));
    assert.ok(metadata.packages.some(pkg => pkg.name === 'varin-kernel'));
    assert.ok(metadata.packages.some(pkg => pkg.name === 'varin-runtime'));
    assert.equal(fs.readFileSync(path.join(cooked, 'crates/varin-kernel/build.rs'), 'utf8').trim(), 'fn main() {}');
    assert.equal(fs.readFileSync(path.join(cooked, 'crates/varin-kernel/src/main.rs'), 'utf8').trim(), 'fn main() {}');
    assert.deepEqual(fs.readFileSync(path.join(cooked, 'vendor/fuser/src/lib.rs')), fs.readFileSync(path.join(source, 'vendor/fuser/src/lib.rs')));
    assert.deepEqual(fs.readFileSync(path.join(cooked, 'vendor/fuser/build.rs')), fs.readFileSync(path.join(source, 'vendor/fuser/build.rs')));
    const checksums = directory => [...fs.readFileSync(path.join(directory, 'Cargo.lock'), 'utf8').matchAll(/^checksum = "([^"]+)"$/gm)].map(match => match[1]).sort();
    assert.deepEqual(checksums(cooked), checksums(source));

    // Changing dependency compilation settings must invalidate the recipe, even though
    // ordinary owner source edits above do not.
    fs.appendFileSync(path.join(source, 'Cargo.toml'), '\n[profile.release]\nopt-level = 2\n');
    run(source, 'chef', 'prepare', '--recipe-path', recipe);
    assert.notEqual(fs.readFileSync(recipe, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
