import { describe, expect, it } from 'vitest';
import pathModule from 'node:path';

import { createTerminalShellResolver, getTerminalShellLoginArgs } from './shells.js';

const createResolver = ({
  platform = 'linux',
  env = {},
  augmentedPath = '/augmented/bin',
  executables = [],
  links = {},
  directories = {},
  purpose = 'terminal',
}: {
  augmentedPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  executables?: string[] | undefined;
  platform?: NodeJS.Platform | undefined;
  links?: Record<string, string>;
  directories?: Record<string, string[]>;
  purpose?: 'terminal' | 'agent';
} = {}) => {
  const available = new Set<string>(executables);
  const path = {
    join: (...parts: string[]) => parts.join(platform === 'win32' ? '\\' : '/'),
  };
  const searches: Array<[string, string]> = [];
  return {
    searches,
    resolver: createTerminalShellResolver({
      fs: { promises: {
        readFile: async () => '',
        readlink: async candidate => { if (links[candidate]) return links[candidate]; throw new Error('not a link'); },
        readdir: async directory => directories[directory] ?? [],
      } },
      path,
      platform,
      env,
      purpose,
      buildAugmentedPath: () => augmentedPath,
      searchPathFor: (name, searchPath) => {
        searches.push([name, searchPath]);
        const suffixes = platform === 'win32' ? ['', '.exe'] : [''];
        for (const suffix of suffixes) {
          const match = [...available].find((candidate) => candidate.toLowerCase().endsWith(`${platform === 'win32' ? '\\' : '/'}${name}${suffix}`.toLowerCase()));
          if (match) return match;
        }
        return null;
      },
      isExecutable: (candidate) => platform === 'win32'
        ? [...available].some(value => value.toLowerCase() === candidate.toLowerCase()) : available.has(candidate),
    }),
  };
};

describe('terminal shell resolver', () => {
  it('prefers Git Bash for Agent auto, preserves terminal auto, and excludes the WSL bash launcher', async () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe', pwsh = 'C:\\Tools\\pwsh.exe';
    const input = { platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files' },
      augmentedPath: 'C:\\Windows\\System32;C:\\Tools', executables: [bash, pwsh, 'C:\\Windows\\System32\\bash.exe'] };
    const agent = createResolver({ ...input, purpose: 'agent' }).resolver;
    expect((await agent.resolve('auto')).executables[0]).toBe(bash);
    expect((await agent.list()).find(shell => shell.id === 'bash')).toMatchObject({ name: 'Git Bash', executable: bash });
    expect((await createResolver(input).resolver.resolve('auto')).executables[0]).toBe(pwsh);
    const noGit = createResolver({ ...input, purpose: 'agent', env: { ...input.env, SHELL: 'C:\\Windows\\System32\\bash.exe' }, executables: [pwsh, 'C:\\Windows\\System32\\bash.exe'] }).resolver;
    expect((await noGit.list()).some(shell => shell.id === 'bash')).toBe(false);
    expect((await noGit.resolve('auto')).executables[0]).toBe(pwsh);
  });
  it('discovers shells from the augmented PTY PATH', async () => {
    const { resolver, searches } = createResolver({ executables: ['/augmented/bin/fish'] });

    await expect(resolver.list()).resolves.toContainEqual({ id: 'fish', name: 'fish', executable: '/augmented/bin/fish', supportsLogin: true });
    expect(searches).toContainEqual(['fish', '/augmented/bin']);
  });

  it('discovers supported PATH-installed shells on Windows', async () => {
    const { resolver } = createResolver({
      platform: 'win32',
      augmentedPath: 'C:\\Tools',
      executables: ['C:\\Tools\\bash.exe', 'C:\\Tools\\nu.exe'],
    });

    await expect(resolver.list()).resolves.toEqual(expect.arrayContaining([
      { id: 'bash', name: 'bash', executable: 'C:\\Tools\\bash.exe', supportsLogin: true },
      { id: 'nu', name: 'nu', executable: 'C:\\Tools\\nu.exe', supportsLogin: true },
    ]));
  });

  it('uses environment overrides before platform defaults for auto', async () => {
    const { resolver } = createResolver({
      env: { VARIN_TERMINAL_SHELL: '/custom/zsh', SHELL: '/bin/bash' },
      executables: ['/custom/zsh', '/bin/bash'],
    });

    await expect(resolver.resolve('auto')).resolves.toEqual({ id: 'auto', executables: ['/custom/zsh', '/bin/bash'] });
  });

  it('resolves a Store execution alias whose file check fails, preserving PATH priority and reporting its real program', async () => {
    const alias = 'C:\\User\\WindowsApps\\pwsh.exe';
    const target = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7\\pwsh.exe';
    const later = 'C:\\Tools\\pwsh.exe';
    const { resolver } = createResolver({ platform: 'win32', augmentedPath: 'C:\\User\\WindowsApps;C:\\Tools',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      executables: [target, later, 'C:\\Windows\\System32\\cmd.exe'], links: { [alias]: target },
    });
    expect((await resolver.resolve('auto')).executables[0]).toBe(target);
    expect(await resolver.list()).toContainEqual({ id: 'pwsh', name: 'PowerShell (pwsh)', executable: target, supportsLogin: false });
    expect((await resolver.resolve('pwsh')).executables).toEqual([target]);
  });

  it('finds stable standard installs outside PATH before previews and CMD, while explicit environment selection wins', async () => {
    const root = 'C:\\Program Files\\PowerShell';
    const stable = pathModule.win32.join(root, '7', 'pwsh.exe');
    const preview = pathModule.win32.join(root, '7-preview', 'pwsh.exe');
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const options = { platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files', ComSpec: cmd },
      executables: [stable, preview, cmd], directories: { [root]: ['7-preview', '7'] },
    };
    expect((await createResolver(options).resolver.resolve('auto')).executables).toEqual([stable, preview, cmd]);
    expect((await createResolver({ ...options, env: { ...options.env, VARIN_TERMINAL_SHELL: cmd } }).resolver.resolve('auto')).executables[0]).toBe(cmd);
  });

  it('uses only known platform-safe login arguments', () => {
    expect(getTerminalShellLoginArgs('/bin/bash', 'linux')).toEqual(['-l']);
    expect(getTerminalShellLoginArgs('/opt/homebrew/bin/fish', 'darwin')).toEqual(['--login']);
    expect(getTerminalShellLoginArgs('/usr/bin/nu', 'linux')).toEqual(['--login']);
    expect(getTerminalShellLoginArgs('/usr/bin/pwsh', 'linux')).toEqual(['-Login']);
    expect(getTerminalShellLoginArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBeNull();
    expect(getTerminalShellLoginArgs('/bin/dash', 'linux')).toBeNull();
  });
});
