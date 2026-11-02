import type {
  ExternalAgentConfiguration,
  ExternalAgentProfile,
} from '@varin/application-client';

// Launches checked against Codeg 6e7e3c3 and Orca 8cd6a7e; versions describe evidence, not a promise about other releases.
// Upstream installation/platform and root version probes checked 2026-11-02:
// opencode.ai/docs/ + docs.opencode.ai/docs/cli/; geminicli.com/docs/get-started/installation/
// moonshotai.github.io/kimi-code/en/guides/getting-started; cursor.com/docs/cli/installation
// docs.qoder.com/cli/installation + /cli/acp; docs.x.ai/build/overview + /build/cli/reference.
// Platform entries are upstream availability, not a claim of local Varin platform/live-account acceptance.
export const ACP_PROFILES: readonly ExternalAgentProfile[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    harness: 'acp',
    description: 'OpenCode CLI over its native ACP stdio interface.',
    installUrl: 'https://opencode.ai/docs/',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'opencode', args: ['acp'] },
    versionArgs: ['--version'],
    authentication:
      'Sign in with opencode auth login on this execution Host. Existing OpenCode account and project settings remain owned by OpenCode.',
    compatibility:
      'Launch reference: OpenCode 2.2.0. OpenCode 1 and 2 share this executable name; capabilities are discovered from the session. Windows is supported upstream, with WSL recommended. No trust or permission bypass is added.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    harness: 'acp',
    description: 'Gemini CLI over its native ACP stdio interface.',
    installUrl: 'https://geminicli.com/docs/',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'gemini', args: ['--acp'] },
    versionArgs: ['--version'],
    authentication:
      'Run Gemini CLI interactively on this execution Host to choose its authentication method and complete any project trust prompt, then reconnect here.',
    compatibility:
      'Launch reference: Gemini CLI 0.60.0. Varin does not pass --skip-trust or change Gemini configuration. Resume and input support come from the live handshake.',
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    harness: 'acp',
    description: 'Kimi Code CLI over its native ACP stdio interface.',
    installUrl:
      'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'kimi', args: ['acp'] },
    versionArgs: ['--version'],
    authentication:
      'Run /login in Kimi Code on this execution Host. Varin does not seed credentials or rewrite Kimi model/provider configuration.',
    compatibility:
      'Launch reference: @moonshot-ai/kimi-code 2.4.0. Windows requires Git for Windows (Git Bash). Authentication depends on the installed release and provider.',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    harness: 'acp',
    description: 'Cursor Agent over its native ACP stdio interface.',
    installUrl: 'https://cursor.com/docs/cli/overview',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'cursor-agent', args: ['acp'] },
    versionArgs: ['--version'],
    authentication:
      'Authenticate in Cursor Agent on this execution Host before connecting. The configured executable must provide the ACP subcommand.',
    compatibility:
      'Launch reference: Cursor Agent 2026.10.22-27dcf5f. The explicit cursor-agent executable avoids the shared agent alias; customize its path if needed. Cursor-specific control extensions are not claimed.',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    harness: 'acp',
    description: 'Qoder CLI over its native ACP stdio interface.',
    installUrl: 'https://docs.qoder.com/cli/installation',
    platforms: ['darwin', 'linux', 'win32'],
    platformArchitectures: { win32: ['x64'] },
    launch: { command: 'qoder', args: ['--acp'] },
    versionArgs: ['--version'],
    authentication:
      'Authenticate in Qoder CLI on this execution Host. Varin reuses the CLI account without importing credentials.',
    compatibility:
      'Launch reference: @qoder-ai/qodercli 1.1.81. Standard form elicitation is supported. Windows requires amd64; native arm64 is not advertised by Qoder.',
  },
  {
    id: 'grok',
    name: 'Grok',
    harness: 'acp',
    description: 'Grok CLI over its native ACP stdio interface.',
    installUrl: 'https://docs.x.ai/build/overview',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'grok', args: ['agent', 'stdio'] },
    versionArgs: ['version'],
    authentication:
      'Sign in with grok login on this execution Host, or use credentials already provided to the CLI environment. Authentication methods are not selected automatically.',
    compatibility:
      'Launch reference: @xai-official/grok 1.0.70. Images require the live capability; Varin does not override sandbox policy or add --always-approve.',
  },
];

export const ACP_DEFAULTS: ExternalAgentConfiguration[] = ACP_PROFILES.map(
  (profile) => ({
    id: profile.id,
    name: profile.name,
    harness: 'acp',
    enabled: false,
    command: profile.launch.command,
    args: [...profile.launch.args],
  }),
);

export function getAcpProfile(id: string): ExternalAgentProfile | undefined {
  return ACP_PROFILES.find((profile) => profile.id === id);
}
