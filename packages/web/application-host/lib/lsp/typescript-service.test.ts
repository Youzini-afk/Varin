import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTypescriptLanguageWorkspace } from './typescript-service.js';

describe('typescript language workspace', () => {
  it('reports a type error and hover for an in-memory TypeScript file', () => {
    const workspace = createTypescriptLanguageWorkspace();
    try {
      const fileName = path.join(os.tmpdir(), 'varin-ts-service.ts');
      workspace.setFile(fileName, 'const greeting: number = "hi";\n', 1);
      const messages = workspace.diagnostics(fileName);
      expect(messages.some((message) => /string|number|assignable/i.test(message))).toBe(true);
      expect(workspace.hover(fileName, 6)).toMatch(/greeting|number|string/i);
      expect(workspace.completion(fileName, 0).length).toBeGreaterThan(0);
    } finally {
      workspace.dispose();
    }
  });

  it('resolves cross-file references through disk reads, and call hierarchy both directions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ts-refs-'));
    const defFile = path.join(dir, 'def.ts');
    const callerFile = path.join(dir, 'caller.ts');
    fs.writeFileSync(defFile, 'export function uniqueTarget() { return 1; }\n');
    fs.writeFileSync(callerFile, 'import { uniqueTarget } from "./def";\nexport function driver() { return uniqueTarget(); }\n');
    // The workspace root must come from the real LSP initialize, not the parent
    // of the first opened file (D-240 rework).
    const workspace = createTypescriptLanguageWorkspace({ workspaceRoot: dir });
    try {
      const defText = fs.readFileSync(defFile, 'utf8');
      // Only def.ts is opened; caller.ts reaches the program through the
      // workspace-root scan + disk read, like a real project load.
      workspace.setFile(defFile, defText, 1);
      const defOffset = defText.indexOf('uniqueTarget');
      const sites = workspace.references(defFile, defOffset);
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('caller.ts'))).toBe(true);

      const items = workspace.prepareCallHierarchy(defFile, defOffset);
      expect(items[0]?.name).toBe('uniqueTarget');
      const incoming = workspace.callHierarchyIncoming(defFile, items[0]!.selectionSpan.start);
      expect(incoming.some((call) => call.from.name === 'driver')).toBe(true);

      const callerText = fs.readFileSync(callerFile, 'utf8');
      workspace.setFile(callerFile, callerText, 1);
      const callerItems = workspace.prepareCallHierarchy(callerFile, callerText.indexOf('driver'));
      const outgoing = workspace.callHierarchyOutgoing(callerFile, callerItems[0]!.selectionSpan.start);
      expect(outgoing.some((call) => call.to.name === 'uniqueTarget')).toBe(true);
    } finally {
      workspace.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the LSP initialize root, not the first opened file parent, so a caller in a sibling directory resolves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ts-root-'));
    const srcA = path.join(dir, 'src', 'a');
    const srcB = path.join(dir, 'src', 'b');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcB, { recursive: true });
    const defFile = path.join(srcA, 'def.ts');
    const callerFile = path.join(srcB, 'caller.ts');
    fs.writeFileSync(defFile, 'export function uniqueTarget() { return 1; }\n');
    fs.writeFileSync(callerFile, 'import { uniqueTarget } from "../a/def";\nexport function driver() { return uniqueTarget(); }\n');
    // The workspace root is the real project root (dir), not src/a — the first
    // opened file's parent. Without the real root, caller.ts in src/b would
    // be outside the project and never resolved (D-240 rework).
    const workspace = createTypescriptLanguageWorkspace({ workspaceRoot: dir });
    try {
      const defText = fs.readFileSync(defFile, 'utf8');
      workspace.setFile(defFile, defText, 1);
      const defOffset = defText.indexOf('uniqueTarget');
      const sites = workspace.references(defFile, defOffset);
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('caller.ts'))).toBe(true);
    } finally {
      workspace.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to cwd without an initialize root and does not infer from the first opened file parent', () => {
    // Without a workspace root, the service must not guess from the first
    // opened file's parent — a file in src/a must not make src/a the root
    // (D-240 rework). The caller in a sibling dir is unreachable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ts-no-root-'));
    const srcA = path.join(dir, 'src', 'a');
    const srcB = path.join(dir, 'src', 'b');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcB, { recursive: true });
    const defFile = path.join(srcA, 'def.ts');
    const callerFile = path.join(srcB, 'caller.ts');
    fs.writeFileSync(defFile, 'export function uniqueTarget() { return 1; }\n');
    fs.writeFileSync(callerFile, 'import { uniqueTarget } from "../a/def";\nexport function driver() { return uniqueTarget(); }\n');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'root-member.ts'), 'import { uniqueTarget } from "../src/a/def";\nuniqueTarget();\n');
    const currentDirectory = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const workspace = createTypescriptLanguageWorkspace();
    try {
      const defText = fs.readFileSync(defFile, 'utf8');
      workspace.setFile(defFile, defText, 1);
      const defOffset = defText.indexOf('uniqueTarget');
      const sites = workspace.references(defFile, defOffset);
      // caller.ts is under a sibling directory, not under cwd, so it must not
      // be resolved when no root was provided.
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('caller.ts'))).toBe(false);
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('root-member.ts'))).toBe(true);
    } finally {
      workspace.dispose();
      currentDirectory.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts setWorkspaceRoot after construction, matching the LSP initialize lifecycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ts-set-root-'));
    const defFile = path.join(dir, 'def.ts');
    const callerFile = path.join(dir, 'caller.ts');
    fs.writeFileSync(defFile, 'export function uniqueTarget() { return 1; }\n');
    fs.writeFileSync(callerFile, 'import { uniqueTarget } from "./def";\nexport function driver() { return uniqueTarget(); }\n');
    const workspace = createTypescriptLanguageWorkspace();
    try {
      workspace.setWorkspaceRoot(dir);
      const defText = fs.readFileSync(defFile, 'utf8');
      workspace.setFile(defFile, defText, 1);
      const defOffset = defText.indexOf('uniqueTarget');
      const sites = workspace.references(defFile, defOffset);
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('caller.ts'))).toBe(true);
    } finally {
      workspace.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

