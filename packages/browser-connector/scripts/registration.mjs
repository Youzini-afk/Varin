import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const extensionId = flag('--extension-id');
const config = flag('--config');
const directory = flag('--output');
if (!/^[a-p]{32}$/.test(extensionId ?? '') || !config || !directory) throw new Error('Required: --extension-id ID --config /absolute/config.json --output /absolute/output');
const output = resolve(directory);
const origin = `chrome-extension://${extensionId}/`;
await access(resolve(config));
await mkdir(output, { recursive: true });
const executable = flag('--native-executable');
let launcher;
if (executable) {
  launcher = resolve(executable); await access(launcher);
  // Compiled executable reads this fixed, adjacent config, never command input.
  if (resolve(config) !== join(dirname(launcher), 'browser-connector.json')) throw new Error('For a compiled host use browser-connector.json beside the executable');
} else {
  if (process.platform === 'win32') throw new Error('Windows registration requires --native-executable from the compile build');
  const main = resolve(dirname(fileURLToPath(import.meta.url)), '../native/main.mjs');
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  launcher = join(output, 'varin-browser-connector');
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(main)} --config ${quote(resolve(config))} "$@"\n`, { mode: 0o700 });
}
const manifest = { name: 'org.varin.browser_connector', description: 'Varin opt-in browser tab connector', path: launcher, type: 'stdio', allowed_origins: [origin] };
const path = join(output, 'org.varin.browser_connector.json');
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Native manifest prepared: ${path}\nRegister it with Chrome or Edge manually after reviewing its exact extension origin. This command changes no browser or system settings.`);
