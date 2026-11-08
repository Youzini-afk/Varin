import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchBuildAsset } from '../../../scripts/download-build-asset.mjs';

const require = createRequire(import.meta.url);
const messages = {
  VarinWorkspaceTitle: ['Independent workspaces', '独立工作区', '獨立工作區'],
  VarinWorkspaceHint: [
    'Optional WinFsp enables isolated Agent workspaces. Normal chats and shared tasks work without it. Installing this system component asks for Windows permission.',
    '可选的 WinFsp 为 Agent 提供独立工作区。普通会话和共享任务无需安装；安装此系统组件时 Windows 会请求授权。',
    '選用的 WinFsp 為 Agent 提供獨立工作區。一般對話和共用任務無需安裝；安裝此系統元件時 Windows 會請求授權。',
  ],
  VarinWorkspaceCheck: ['Install or update WinFsp ({release})', '安装或更新 WinFsp（{release}）', '安裝或更新 WinFsp（{release}）'],
  VarinWorkspaceReuse: ['A compatible WinFsp is already installed and will be reused.', '已检测到兼容的 WinFsp，将复用现有组件。', '已偵測到相容的 WinFsp，將使用現有元件。'],
  VarinWorkspaceSkipped: [
    'WinFsp was not installed (result {result}). Varin remains usable; install the component later to enable independent workspaces.',
    'WinFsp 未完成安装（结果 {result}）。Varin 仍可正常使用，之后安装组件即可启用独立工作区。',
    'WinFsp 未完成安裝（結果 {result}）。Varin 仍可正常使用，之後安裝元件即可啟用獨立工作區。',
  ],
  VarinWorkspaceRestart: [
    'WinFsp is installed and requires a Windows restart. Independent workspaces become available after restarting Windows. You can continue installing Varin.',
    'WinFsp 已安装，需要重启 Windows 后才能使用独立工作区。你可以继续安装 Varin。',
    'WinFsp 已安裝，需要重新啟動 Windows 後才能使用獨立工作區。你可以繼續安裝 Varin。',
  ],
};

const resources = fileURLToPath(new URL('../resources/', import.meta.url));
export async function downloadWorkspaceAsset(url, { request = fetchBuildAsset, wait = delay } = {}) {
  const delays = [1000, 3000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(url);
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`WinFsp download failed (${response.status})`), { status: response.status });
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const temporary = [408, 429, 500, 502, 503, 504].includes(error.status)
        || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code ?? error.code);
      if (!temporary || attempt === delays.length) throw error;
      console.warn('[electron] WinFsp download interrupted; retrying the same official asset');
      await wait(delays[attempt]);
    }
  }
}
export async function prepareWorkspaceComponent() {
  const component = JSON.parse(await readFile(path.join(resources, 'workspace-component.json'), 'utf8'));
  const directory = path.join(resources, 'workspace-component');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, component.file);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!existing || digest(existing) !== component.sha256) {
    const bytes = await downloadWorkspaceAsset(component.url);
    if (digest(bytes) !== component.sha256) throw new Error('Official WinFsp MSI checksum mismatch');
    const temporary = `${target}.${process.pid}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  const licenseFile = path.join(directory, 'License.txt');
  const cachedLicense = await readFile(licenseFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!cachedLicense || digest(cachedLicense) !== component.licenseSha256) {
    const bytes = await downloadWorkspaceAsset(component.licenseUrl);
    if (digest(bytes) !== component.licenseSha256) throw new Error('WinFsp license checksum mismatch');
    await writeFile(licenseFile, bytes);
  }
  await writeFile(path.join(directory, 'component.nsh'), [
    `!define VARIN_WINFSP_FILE "${component.file}"`,
    `!define VARIN_WINFSP_VERSION "${component.version}.0"`,
    `!define VARIN_WINFSP_RELEASE "${component.release}"`, '',
  ].join('\n'));
  // Follow the builder's actual language list, as the main installer does.
  // NSIS requires a value in every enabled table, including English fallback.
  const builder = createRequire(require.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const { bundledLanguages, lcid } = library('./util/langs');
  const strings = [];
  for (const [key, translations] of Object.entries(messages)) {
    for (const lang of bundledLanguages) {
      const text = translations[lang === 'zh_CN' ? 1 : lang === 'zh_TW' ? 2 : 0]
        .replaceAll('$', '$$').replaceAll('"', '$\\"')
        .replaceAll('{release}', '${VARIN_WINFSP_RELEASE}').replaceAll('{result}', '$VarinWorkspaceResult');
      strings.push(`LangString ${key} ${lcid[lang]} "${text}"`);
    }
  }
  await writeFile(path.join(directory, 'strings.nsh'), '\uFEFF' + strings.join('\n') + '\n');
  console.log(`[electron] Prepared unmodified WinFsp ${component.release} (${component.sha256})`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWorkspaceComponent();
