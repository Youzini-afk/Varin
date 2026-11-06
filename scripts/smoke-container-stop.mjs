import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Consume the already-started exact candidate. No second build or test-only
// production hook: this checks the image's real signal/foreground exit contract.
const [name, variant] = process.argv.slice(2);
if (!name || !['slim', 'toolbelt'].includes(variant)) throw new Error('Usage: smoke-container-stop.mjs <container> slim|toolbelt');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
docker('exec', name, 'node', '-e', `
  const fs = require('node:fs');
  const value = JSON.parse(fs.readFileSync('/etc/varin/image-capabilities.json', 'utf8'));
  const variant = process.argv[1];
  if (value.schema !== 1 || value.variant !== variant || process.env.VARIN_IMAGE_VARIANT !== variant
    || value.chrome !== (variant === 'toolbelt' && process.arch === 'x64')) throw new Error('Image capabilities do not match the selected variant/architecture');
`, variant);
if (docker('inspect', '--format', '{{index .Config.Labels "io.varin.image.variant"}}', name) !== variant
  || docker('inspect', '--format', '{{index .Config.Labels "io.varin.image.role"}}', name) !== 'application') {
  throw new Error('Application role or variant label does not match its capability metadata');
}
const started = performance.now();
docker('kill', '--signal=TERM', name);
let state;
while (performance.now() - started < 15_000) {
  state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
  if (!state.Running) break;
  await delay(100);
}
if (state?.Running || state?.ExitCode !== 143 || state?.OOMKilled) {
  throw new Error(`Container did not complete its normal foreground SIGTERM within supervision grace: ${JSON.stringify(state)}`);
}
const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
if (logs.status !== 0) throw new Error('Cannot inspect shutdown evidence');
const outcomes = `${logs.stdout}\n${logs.stderr}`.split('\n').flatMap(line => {
  const match = /^\[Shutdown\] (\{.*\})$/.exec(line.trim());
  return match ? [JSON.parse(match[1])] : [];
});
if (!outcomes.some(result => result.outcome === 'graceful') || outcomes.some(result => result.outcome === 'incomplete')) {
  throw new Error('Container exited without a truthful graceful owner-drain receipt');
}
console.log(`Verified ${variant} metadata and real SIGTERM shutdown in ${Math.round(performance.now() - started)} ms`);
