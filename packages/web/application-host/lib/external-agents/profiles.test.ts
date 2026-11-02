import { expect, it } from 'vitest';
import { ACP_DEFAULTS, ACP_PROFILES, getAcpProfile } from './profiles.js';
import {
  assertProfilePlatform,
  profileVersionArguments,
} from './profile-launch.js';

it('supplies disabled editable launch configurations, not auto-install or permission bypass commands', () => {
  expect(
    ACP_DEFAULTS.map(({ id, command, args }) => [id, command, args]),
  ).toEqual([
    ['opencode', 'opencode', ['acp']],
    ['gemini', 'gemini', ['--acp']],
    ['kimi', 'kimi', ['acp']],
    ['cursor', 'cursor-agent', ['acp']],
    ['qoder', 'qoder', ['--acp']],
    ['grok', 'grok', ['agent', 'stdio']],
  ]);
  for (const configuration of ACP_DEFAULTS) {
    expect(configuration.enabled).toBe(false);
    const profile = getAcpProfile(configuration.id)!;
    expect(profile.authentication).toBeTruthy();
    expect(profile.compatibility).toBeTruthy();
    expect(profile.installUrl?.startsWith('https://')).toBe(true);
    expect(profile.versionArgs).toEqual(
      profile.id === 'grok' ? ['version'] : ['--version'],
    );
    expect(profile.launch.args).not.toBe(configuration.args);
  }
  expect(ACP_PROFILES).toHaveLength(6);
  expect(getAcpProfile('custom')).toBeUndefined();
});

it('feeds evidenced launch and platform differences into Host preflight', () => {
  const qoder = getAcpProfile('qoder');
  expect(() => assertProfilePlatform(qoder, 'win32', 'arm64')).toThrow(
    'win32/arm64',
  );
  expect(() => assertProfilePlatform(qoder, 'win32', 'x64')).not.toThrow();
  for (const profile of ACP_PROFILES) {
    expect(profileVersionArguments(profile.launch.args, profile)).toEqual(
      profile.versionArgs,
    );
    expect(() => assertProfilePlatform(profile, 'linux', 'x64')).not.toThrow();
  }
});
