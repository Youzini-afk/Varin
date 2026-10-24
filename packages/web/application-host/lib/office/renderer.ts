import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { OfficeFormat } from '@varin/protocol';
import type { ManagedSpawn } from '../process/types.js';
import { executableExists, runOwnedCommand, type ProcessDirectoryState } from '../process/run-command.js';

export type OfficeExportFormat = OfficeFormat | 'pdf' | 'csv';
export class OfficeRenderFailure extends Error {
  constructor(cause: unknown, readonly executorStopped: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
export function createOfficeRenderer(options: { spawn: ManagedSpawn; temporaryRoot: string; command?: () => string | undefined }) {
  const executable = async (): Promise<string | undefined> => {
    const explicit = options.command?.();
    const candidates = explicit ? [explicit] : [
      'soffice',
      ...(process.platform === 'win32' ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => !!value)
        .map(root => path.join(root, 'LibreOffice', 'program', 'soffice.exe')) : []),
      ...(process.platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice'] : []),
    ];
    for (const candidate of candidates) if (await executableExists(candidate)) return candidate;
    return undefined;
  };
  return {
    async environment() {
      const require = createRequire(import.meta.url);
      const command = await executable();
      return {
        formats: { docx: { read: true, create: true, editText: true, preserveOtherParts: true },
          xlsx: { read: true, create: true, editCells: true, preserveOtherParts: true, recalculate: !!command },
          pptx: { read: true, create: true, editTextAndGeometry: true, preserveOtherParts: true } },
        javascript: { modules: Object.fromEntries(['docx', 'exceljs', 'pptxgenjs', 'adm-zip'].map(name => [name, require.resolve(name)])),
          usage: 'These are reusable module entry paths on this Host. In a JavaScript environment on this Host, load them with createRequire from node:module. File source and process permissions still belong to the selected task.' },
        rendering: command ? { available: true, engine: 'LibreOffice', command }
          : { available: false, engine: 'LibreOffice', reason: 'LibreOffice was not found on this Host. Configure its executable or use a connected desktop with computer_office. Structure reading, creation and local edits are available.' },
      };
    },
    async convert(bytes: Buffer, sourceFormat: OfficeFormat, format: OfficeExportFormat, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const command = await executable();
      if (!command) throw new Error('LibreOffice is unavailable on this Host; office_environment shows available format and application paths');
      const root = await mkdtemp(path.join(options.temporaryRoot, 'office-'));
      const cleanup = async () => { try { await rm(root, { recursive: true, force: true }); }
        catch { console.warn('[Office] Conversion finished; its private temporary directory could not be removed'); } };
      const state: ProcessDirectoryState = { safeToRemove: true, onLateExitConfirmed: cleanup };
      try {
        const output = path.join(root, 'output'), profile = path.join(root, 'profile');
        await mkdir(output); await mkdir(profile);
        const source = path.join(root, `source.${sourceFormat}`);
        await writeFile(source, bytes);
        const version = await runOwnedCommand(options.spawn, command, ['--version'], root, signal, state);
        // A private profile prevents conversion from attaching to or closing the user's live Office session.
        const conversion = await runOwnedCommand(options.spawn, command, [`-env:UserInstallation=${pathToFileURL(profile).href}`,
          '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--convert-to', format, '--outdir', output, source], root, signal, state);
        signal?.throwIfAborted();
        let result: Buffer;
        try { result = await readFile(path.join(output, `source.${format}`)); }
        catch { throw new Error(`LibreOffice produced no ${format} output. ${(conversion.stderr || conversion.stdout).trim()}`); }
        return { bytes: result, format, engine: { name: 'LibreOffice', version: version.stdout.trim() || version.stderr.trim() },
          recalculated: sourceFormat === 'xlsx' && format === 'xlsx' };
      } catch (error) { throw new OfficeRenderFailure(error, state.safeToRemove); }
      finally { if (state.safeToRemove) await cleanup(); }
    },
  };
}
export type OfficeRenderer = ReturnType<typeof createOfficeRenderer>;
