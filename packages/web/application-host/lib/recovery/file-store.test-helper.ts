/**
 * Small real-file fixture for Host recovery tests, not a native storage substitute.
 * It prepares before/after states; tests inject owner failures at the returned methods.
 * Concurrent capture, atomic replacement and crash durability belong to Rust tests.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { objectPath } from './object-path.js';
import { RecoveryPrimitiveError } from './errors.js';
import { createRecoveryFileReader, type RecoveryFileStore, type RecoveryIdentity, type RecoveryState, type RegularFileState, type CaptureStateOptions, type CapturedState } from './journal-files.js';

export const createRecoveryFileStore = (): RecoveryFileStore => {
  const { relativePathFor, hashFile } = createRecoveryFileReader();

  const captureState = async (
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    { store = true }: CaptureStateOptions = {},
  ): Promise<CapturedState> => {
    const resolved = await relativePathFor(identity, inputPath);
    let stat: Stats;
    try {
      stat = await fs.lstat(resolved.absolute);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        return { path: resolved.relative, state: { kind: 'missing' } };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {
        path: resolved.relative,
        state: { kind: 'symlink', symlinkTarget: await fs.readlink(resolved.absolute) },
      };
    }
    if (stat.isDirectory()) {
      return { path: resolved.relative, state: { kind: 'directory', mode: stat.mode & 0o7777 } };
    }
    if (!stat.isFile()) return { path: resolved.relative, state: { kind: 'unsupported' } };
    const bytes = await fs.readFile(resolved.absolute);
    const state: RegularFileState = {
      kind: 'regular-file',
      byteLength: bytes.length,
      objectHash: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
      mode: stat.mode & 0o7777,
    };
    if (store) {
      const target = objectPath(root, state.objectHash);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        // Keep existing objects, including corrupt ones, visible to verification.
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    }
    return { path: resolved.relative, state };
  };

  const verifyObject = async (root: string, state: RecoveryState): Promise<void> => {
    if (state.kind !== 'regular-file') return;
    const actual = await hashFile(objectPath(root, state.objectHash));
    if (actual.objectHash !== state.objectHash || actual.byteLength !== state.byteLength) {
      throw new RecoveryPrimitiveError('object-corrupt', `Recovery object failed verification: ${state.objectHash}`);
    }
  };

  const removePath = async (absolute: string): Promise<void> => {
    let stat: Stats;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }
    // Do not hide incorrect parent/child ordering by recursively deleting a tree.
    if (stat.isDirectory()) await fs.rmdir(absolute);
    else await fs.unlink(absolute);
  };

  const applyState = async (
    identity: RecoveryIdentity,
    root: string,
    relativePath: string,
    state: RecoveryState,
  ): Promise<void> => {
    const { absolute } = await relativePathFor(identity, relativePath);
    if (state.kind === 'missing') return removePath(absolute);
    if (state.kind === 'directory') {
      try {
        const existing = await fs.lstat(absolute);
        if (!existing.isDirectory()) await fs.unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      await fs.mkdir(absolute, { recursive: true });
      if (state.mode !== undefined) await fs.chmod(absolute, state.mode);
      return;
    }
    if (state.kind === 'symlink') {
      await removePath(absolute);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.symlink(state.symlinkTarget, absolute);
      return;
    }
    if (state.kind !== 'regular-file') {
      throw new RecoveryPrimitiveError('unsupported-metadata', `Unsupported recovery path: ${relativePath}`);
    }
    await verifyObject(root, state);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await removePath(absolute);
    await fs.copyFile(objectPath(root, state.objectHash), absolute);
    if (state.mode !== undefined) await fs.chmod(absolute, state.mode);
  };

  return { applyState, captureState, hashFile, relativePathFor, verifyObject };
};
