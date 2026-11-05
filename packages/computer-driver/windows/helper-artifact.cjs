/** Shared build/package validation. Never runs in the desktop helper process. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { detectKernelBinaryIdentity } = require('../../../scripts/kernel-binary-identity.cjs');
const PROTOCOL_VERSION = 1;
const EXECUTABLE = 'VarinComputer.exe';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inspectExecutable(bytes, architecture) {
  const identity = detectKernelBinaryIdentity(bytes);
  if (identity.platform !== 'win32' || identity.format !== 'pe' || identity.arch !== architecture) throw new Error(`Computer helper PE architecture mismatch (expected ${architecture})`);
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  if (optional + 112 > bytes.length || bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Computer helper must have a valid PE32+ optional header');
  const sectionCount = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const sectionStart = optional + optionalSize;
  if (optionalSize < 128 || sectionStart + sectionCount * 40 > bytes.length) throw new Error('Computer helper PE sections are truncated');
  const offset = rva => {
    for (let i = 0; i < sectionCount; i++) {
      const at = sectionStart + i * 40, address = bytes.readUInt32LE(at + 12), size = bytes.readUInt32LE(at + 16);
      if (rva >= address && rva < address + size) {
        const result = bytes.readUInt32LE(at + 20) + rva - address;
        if (result >= bytes.length) break;
        return result;
      }
    }
    throw new Error('Computer helper PE import points outside a section');
  };
  const nameAt = rva => {
    const start = offset(rva), end = bytes.indexOf(0, start);
    if (end < 0) throw new Error('Computer helper PE import name is unterminated');
    return bytes.toString('ascii', start, end).toLowerCase();
  };
  const imports = [];
  const directories = bytes.readUInt32LE(optional + 108);
  const readImports = (directory, width, nameOffset) => {
    if (directories <= directory || optionalSize < 112 + (directory + 1) * 8) return;
    const rva = bytes.readUInt32LE(optional + 112 + directory * 8);
    if (!rva) return;
    let at = offset(rva);
    while (at + width <= bytes.length) {
      if (bytes.subarray(at, at + width).every(value => value === 0)) return;
      if (directory === 13 && !(bytes.readUInt32LE(at) & 1)) throw new Error('Unsupported Computer helper delay-import addressing');
      imports.push(nameAt(bytes.readUInt32LE(at + nameOffset))); at += width;
    }
    throw new Error('Computer helper PE imports are truncated');
  };
  readImports(1, 20, 12); readImports(13, 32, 4);
  const system = new Set(['advapi32.dll', 'bcrypt.dll', 'comctl32.dll', 'comdlg32.dll', 'crypt32.dll', 'dwmapi.dll', 'gdi32.dll', 'imm32.dll', 'kernel32.dll', 'kernelbase.dll', 'msvcrt.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'propsys.dll', 'rpcrt4.dll', 'secur32.dll', 'shell32.dll', 'shlwapi.dll', 'uiautomationcore.dll', 'user32.dll', 'userenv.dll', 'version.dll', 'windowscodecs.dll', 'winmm.dll', 'ws2_32.dll', 'dbghelp.dll', 'ucrtbase.dll']);
  for (const name of imports) if (!system.has(name) && !/^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(name)) {
    throw new Error(`Computer helper imports an unbundled non-system DLL: ${name}`);
  }
  return { architecture: identity.arch, imports: [...new Set(imports)].sort() };
}

function readSignature(executable, run = execFileSync) {
  const env = { ...process.env, VARIN_SIGNATURE_FILE: executable };
  // A build launched from pwsh can inherit its incompatible module path.
  // Use Windows PowerShell's own built-ins only, without changing the caller.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:VARIN_SIGNATURE_FILE; @{ status=$s.Status.ToString(); subject=$s.SignerCertificate.Subject; thumbprint=$s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, env });
  const signature = JSON.parse(String(result).trim());
  if (signature.status === 'NotSigned') return { status: 'unsigned' };
  if (signature.status !== 'Valid' || !signature.thumbprint) throw new Error(`Computer helper Authenticode verification failed: ${signature.status}`);
  return { status: 'valid', subject: signature.subject, thumbprint: signature.thumbprint };
}

function verifyHelper(directory, { architecture, version, requireSignature = false, verifySignature = process.platform === 'win32', run } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const executable = path.join(directory, EXECUTABLE), bytes = fs.readFileSync(executable);
  if (manifest.schema !== 1 || manifest.protocolVersion !== PROTOCOL_VERSION || manifest.executable !== EXECUTABLE
    || !['x64', 'arm64'].includes(manifest.architecture)
    || manifest.target !== ({ x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' })[manifest.architecture] || (architecture && manifest.architecture !== architecture)
    || typeof manifest.version !== 'string' || (version && manifest.version !== version) || !/^[a-f0-9]{64}$/.test(manifest.buildId)
    || manifest.sha256 !== digest(bytes)) throw new Error('Computer helper manifest/build/digest mismatch');
  const binary = inspectExecutable(bytes, manifest.architecture);
  if (JSON.stringify(binary.imports) !== JSON.stringify(manifest.imports)) throw new Error('Computer helper import manifest mismatch');
  if (!['unsigned', 'valid'].includes(manifest.signature?.status)) throw new Error('Computer helper signature state is missing');
  if (verifySignature) {
    const actual = readSignature(executable, run);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.signature)) throw new Error('Computer helper signature does not match its manifest');
  }
  if (requireSignature && manifest.signature.status !== 'valid') throw new Error('A verified publisher signature is required for the Computer helper');
  const allowed = new Set([EXECUTABLE, 'manifest.json']);
  for (const name of fs.readdirSync(directory)) if (!allowed.has(name)) throw new Error(`Non-runtime Computer helper file entered the payload: ${name}`);
  return manifest;
}
module.exports = { PROTOCOL_VERSION, EXECUTABLE, digest, inspectExecutable, readSignature, verifyHelper };
