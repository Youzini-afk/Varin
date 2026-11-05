import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Only for tests that supply createDriver themselves. Resolving an installed
 * native artifact must not depend on a developer having compiled Windows code. */
export function computerDriverFixture(root: string): string {
  const directory = join(root, 'driver-fixture');
  mkdirSync(join(directory, 'windows'), { recursive: true });
  writeFileSync(join(directory, 'windows', 'VarinComputer.exe'), 'Controlled driver port fixture; never execute');
  writeFileSync(join(directory, 'windows', 'manifest.json'), JSON.stringify({ schema: 1, protocolVersion: 1,
    executable: 'VarinComputer.exe', version: '0.0.0', architecture: process.arch, buildId: 'controlled-driver-port' }));
  mkdirSync(join(directory, 'linux'), { recursive: true });
  writeFileSync(join(directory, 'linux', 'driver-host.py'), '# Controlled driver port fixture; never execute');
  return directory;
}
