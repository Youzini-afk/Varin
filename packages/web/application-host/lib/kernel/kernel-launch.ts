/** Executable selection and installed-artifact validation shared by private kernel modes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { KERNEL_PROTOCOL_VERSION } from './protocol.generated.js';
import { KernelClientError } from './kernel-error.js';

export interface KernelLaunchOptions {
  kernelPath?: string;
  allowCargoDevRunner?: boolean;
  kernelBuildIdentity?: string;
  targetTriple?: string;
  targetArch?: string;
  requireKernelManifest?: boolean;
}
interface KernelManifest {
  schema: number;
  executable: string;
  targetTriple: string;
  platform: string;
  arch: string;
  binaryFormat: 'pe' | 'elf' | 'macho';
  buildIdentity: string;
  protocolVersion: number;
  kernelVersion: string;
  sha256: string;
}

const defaultKernelCandidates = (): string[] => {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.VARIN_KERNEL_PATH?.trim() || '',
    path.resolve(moduleDirectory, '../../../../../kernel', `varin-kernel${extension}`),
    path.resolve(moduleDirectory, '../../../../../../kernel', `varin-kernel${extension}`),
    path.resolve(moduleDirectory, '../../../../../kernel', 'target', 'release', `varin-kernel${extension}`),
    path.resolve(moduleDirectory, '../../../../../kernel', 'target', 'debug', `varin-kernel${extension}`),
    path.resolve(moduleDirectory, '../../../../kernel', `varin-kernel${extension}`),
    path.resolve(moduleDirectory, '../../../kernel', `varin-kernel${extension}`),
    path.resolve(process.cwd(), 'kernel', `varin-kernel${extension}`),
    path.resolve(process.cwd(), 'kernel', 'target', 'release', `varin-kernel${extension}`),
    path.resolve(process.cwd(), 'kernel', 'target', 'debug', `varin-kernel${extension}`),
  ].filter(Boolean);
};

export async function prepareKernelCommand(options: KernelLaunchOptions = {}): Promise<{
  command: string; args: string[]; manifest: KernelManifest | null;
}> {
  const requireManifest = options.requireKernelManifest ?? process.env.NODE_ENV === 'production';
  const executable = options.kernelPath?.trim() || defaultKernelCandidates().find(candidate => fs.existsSync(candidate));
  if (!executable) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const cargoManifest = [path.resolve(moduleDirectory, '../../../../../kernel/Cargo.toml'), path.resolve(process.cwd(), 'kernel/Cargo.toml')]
      .find(candidate => fs.existsSync(candidate));
    if ((options.allowCargoDevRunner ?? process.env.NODE_ENV !== 'production') && cargoManifest) {
      if (requireManifest) throw new KernelClientError({ code: 'kernel-manifest-missing', message: 'Rust kernel manifest is required for this Host' });
      return { command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
        args: ['run', '--quiet', '--manifest-path', cargoManifest, '--bin', 'varin-kernel', '--'], manifest: null };
    }
    throw new KernelClientError({ code: 'kernel-entry-unavailable',
      message: 'Varin Rust kernel executable is unavailable; build the kernel or set VARIN_KERNEL_PATH' });
  }
  const manifestPath = path.join(path.dirname(executable), 'manifest.json');
  let manifest: KernelManifest | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as KernelManifest;
      const digest = createHash('sha256').update(await fs.promises.readFile(executable)).digest('hex');
      if (manifest.schema !== 3 || manifest.sha256 !== digest || manifest.protocolVersion !== KERNEL_PROTOCOL_VERSION
        || manifest.platform !== process.platform || manifest.arch !== (options.targetArch ?? process.arch)
        || (options.targetTriple !== undefined && manifest.targetTriple !== options.targetTriple)
        || (options.kernelBuildIdentity !== undefined && manifest.buildIdentity !== options.kernelBuildIdentity)) {
        throw new KernelClientError({ code: 'kernel-manifest-mismatch', message: 'Rust kernel manifest does not match this Host' });
      }
    } catch (error) {
      if (error instanceof KernelClientError) throw error;
      throw new KernelClientError({ code: 'kernel-manifest-invalid', message: `Rust kernel manifest is invalid: ${String(error)}` });
    }
  } else if (requireManifest) {
    throw new KernelClientError({ code: 'kernel-manifest-missing', message: 'Rust kernel manifest is required for this Host' });
  }
  return { command: executable, args: [], manifest };
}
