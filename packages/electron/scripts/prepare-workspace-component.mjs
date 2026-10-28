import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = fileURLToPath(new URL('../resources/', import.meta.url));
export async function prepareWorkspaceComponent() {
  const component = JSON.parse(await readFile(path.join(resources, 'workspace-component.json'), 'utf8'));
  const directory = path.join(resources, 'workspace-component');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, component.file);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!existing || digest(existing) !== component.sha256) {
    const response = await fetch(component.url);
    if (!response.ok) throw new Error(`WinFsp download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== component.sha256) throw new Error('Official WinFsp MSI checksum mismatch');
    const temporary = `${target}.${process.pid}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  const licenseFile = path.join(directory, 'License.txt');
  const cachedLicense = await readFile(licenseFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!cachedLicense || digest(cachedLicense) !== component.licenseSha256) {
    const license = await fetch(component.licenseUrl);
    if (!license.ok) throw new Error(`WinFsp license download failed (${license.status})`);
    const bytes = Buffer.from(await license.arrayBuffer());
    if (digest(bytes) !== component.licenseSha256) throw new Error('WinFsp license checksum mismatch');
    await writeFile(licenseFile, bytes);
  }
  await writeFile(path.join(directory, 'component.nsh'), [
    `!define VARIN_WINFSP_FILE "${component.file}"`,
    `!define VARIN_WINFSP_VERSION "${component.version}.0"`,
    `!define VARIN_WINFSP_RELEASE "${component.release}"`, '',
  ].join('\n'));
  console.log(`[electron] Prepared unmodified WinFsp ${component.release} (${component.sha256})`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWorkspaceComponent();
