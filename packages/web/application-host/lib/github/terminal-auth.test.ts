import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import {
  configureGitHubGitAuthor,
  installTerminalGitHubAuth,
  isTerminalGitHubAuthConfigured,
} from './terminal-auth.js';

const makeTempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'varin-gh-terminal-'));

describe('terminal GitHub auth helpers', () => {
  it('writes the active Varin GitHub account to gh hosts.yml', () => {
    const homeDir = makeTempHome();
    const authFilePath = path.join(homeDir, '.config', 'varin', 'github-auth.json');

    const result = installTerminalGitHubAuth({
      auth: {
        accessToken: 'gho_test_token',
        user: { login: 'youzini' },
      },
      homeDir,
      authFilePath,
      configureGit: false,
    });

    const hostsPath = path.join(homeDir, '.config', 'gh', 'hosts.yml');
    const hosts = YAML.parse(fs.readFileSync(hostsPath, 'utf8'));

    expect(result.ghConfigPath).toBe(hostsPath);
    expect(hosts).toEqual({
      'github.com': {
        git_protocol: 'https',
        oauth_token: 'gho_test_token',
        user: 'youzini',
      },
    });
    expect(isTerminalGitHubAuthConfigured({
      auth: { accessToken: 'gho_test_token' },
      homeDir,
      authFilePath,
    }).configured).toBe(true);
  });

  it('installs a Git credential helper without storing the token in git config', () => {
    const homeDir = makeTempHome();
    const authFilePath = path.join(homeDir, '.config', 'varin', 'github-auth.json');
    const spawnSync = vi.fn(() => ({ status: 0, error: null, stderr: Buffer.from('') }));

    const result = installTerminalGitHubAuth({
      auth: {
        accessToken: 'gho_secret',
        user: { login: 'youzini' },
      },
      homeDir,
      authFilePath,
      spawnSync,
    });

    const helper = fs.readFileSync(result.helperPath, 'utf8');
    expect(helper).toContain(JSON.stringify(authFilePath));
    expect(helper).not.toContain('gho_secret');
    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      [
        'config',
        '--global',
        '--replace-all',
        'credential.https://github.com.helper',
        expect.stringContaining('git-credential-varin-github.cjs'),
      ],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('rejects terminal sync when no active GitHub token exists', () => {
    expect(() => installTerminalGitHubAuth({
      auth: null,
      homeDir: makeTempHome(),
      authFilePath: path.join(makeTempHome(), 'github-auth.json'),
    })).toThrow('GitHub is not connected');
  });

  it('configures global git author from the active GitHub user', () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: null, stderr: Buffer.from('') }));

    const result = configureGitHubGitAuthor({
      auth: {
        accessToken: 'gho_test',
        user: {
          login: 'youzini-afk',
          id: 12345,
          name: 'youzini',
          email: 'an48934293@gmail.com',
        },
      },
      spawnSync,
    });

    expect(result).toEqual({
      success: true,
      userName: 'youzini',
      userEmail: 'an48934293@gmail.com',
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['config', '--global', '--replace-all', 'user.name', 'youzini'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['config', '--global', '--replace-all', 'user.email', 'an48934293@gmail.com'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('falls back to the GitHub noreply email when the account email is private', () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: null, stderr: Buffer.from('') }));

    const result = configureGitHubGitAuthor({
      auth: {
        accessToken: 'gho_test',
        user: {
          login: 'youzini-afk',
          id: 12345,
          name: '',
          email: null,
        },
      },
      spawnSync,
    });

    expect(result.userName).toBe('youzini-afk');
    expect(result.userEmail).toBe('12345+youzini-afk@users.noreply.github.com');
  });
});
