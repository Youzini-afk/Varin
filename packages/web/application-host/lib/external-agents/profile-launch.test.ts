import { expect, it } from 'vitest';
import type { ExternalAgentProfile } from '@varin/application-client';
import { assertProfilePlatform, profileVersionArguments } from './profile-launch.js';

const profile: ExternalAgentProfile = { id: 'grok', name: 'Grok', harness: 'acp', description: '',
  platforms: ['linux', 'win32'], platformArchitectures: { win32: ['x64'] },
  launch: { command: 'grok', args: ['agent', 'stdio'] }, versionArgs: ['version'] };
it('probes the CLI rather than its protocol server and preserves launcher prefixes', () => {
  expect(profileVersionArguments(['agent', 'stdio'], profile)).toEqual(['version']);
  expect(profileVersionArguments(['/npm/grok.js', '--custom', 'agent', 'stdio'], profile)).toEqual(['/npm/grok.js', '--custom', 'version']);
  expect(profileVersionArguments(['/custom/bridge.js'], profile)).toEqual(['/custom/bridge.js', '--version']);
  expect(profileVersionArguments(['custom'], undefined)).toEqual(['custom', '--version']);
});
it('checks only evidenced platform restrictions and leaves custom protocols to their actual connection', () => {
  expect(() => assertProfilePlatform(profile, 'win32', 'x64')).not.toThrow();
  expect(() => assertProfilePlatform(profile, 'win32', 'arm64')).toThrow('win32/arm64');
  expect(() => assertProfilePlatform(profile, 'darwin', 'arm64')).toThrow('darwin/arm64');
  expect(() => assertProfilePlatform(undefined, 'freebsd', 'arm')).not.toThrow();
});
