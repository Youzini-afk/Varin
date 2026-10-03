import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Immutable initial metadata; each consumer test mutates its own Git repository. */
export function createGitTemplate(initialize: (directory: string) => void) {
  let template: string | undefined;
  return {
    copyTo(directory: string): void {
      if (!template) {
        const candidate = mkdtempSync(join(tmpdir(), 'varin-git-template-'));
        try {
          initialize(candidate);
          template = candidate;
        } catch (error) {
          rmSync(candidate, { recursive: true, force: true });
          throw error;
        }
      }
      cpSync(template, directory, { recursive: true });
    },
    dispose(): void {
      if (template) rmSync(template, { recursive: true, force: true });
      template = undefined;
    },
  };
}
