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
const EXISTING_ACP_PROFILES: readonly ExternalAgentProfile[] = [
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
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    harness: 'acp',
    description: 'DeepSeek Harness over its automation-only ACP stdio profile.',
    installUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    platforms: ['darwin', 'linux', 'win32'],
    launch: { command: 'dsh', args: ['--profile', 'acp'] },
    versionArgs: ['--version'],
    authentication:
      'Sign dsh in on this execution Host, or point its acp profile at a gateway in that profile. Varin does not seed credentials or rewrite dsh model/provider configuration.',
    compatibility:
      'Launch reference: dsh 0.2.2-rc.3. The acp profile is automation-only by design: it exposes the standard ACP surface and omits DSH-specific presentation, so plans, titles and terminal views do not appear. Resume, list and close come from the live handshake.',
  },
];

function acp(id: string, name: string, command: string, args: string[], installUrl: string, compatibility: string): ExternalAgentProfile {
  return { id, name, harness: 'acp', description: `${name} over ACP.`, installUrl,
    platforms: ['darwin', 'linux', 'win32'], launch: { command, args }, versionArgs: ['--version'],
    authentication: `Complete authentication using ${name} on this execution Host.`, compatibility };
}

// Source: Codeg 4991406e6 registry and the linked upstream distribution contracts.
// These are launch recipes. Authentication, models and session capabilities belong to the program.
const ADDITIONAL_ACP_PROFILES: ExternalAgentProfile[] = [
  acp('cline', 'Cline', 'cline', ['--acp'], 'https://docs.cline.bot/cline-cli/overview', 'Native Cline CLI ACP; uses the installed CLI configuration.'),
  acp('codebuddy', 'CodeBuddy', 'codebuddy', ['--acp'], 'https://www.codebuddy.ai/cli', 'Native CodeBuddy CLI ACP.'),
  acp('openclaw', 'OpenClaw', 'openclaw', ['acp'], 'https://docs.openclaw.ai/cli/acp', 'Requires an existing configured OpenClaw Gateway. Installing the CLI does not provision a Gateway.'),
  acp('hermes', 'Hermes Agent', 'hermes', ['acp'], 'https://github.com/NousResearch/hermes-agent', 'Uses the official Hermes installation and its shared Gateway. The npm hermes-agent wrapper is a separate community distribution.'),
  { ...acp('antigravity', 'Google Antigravity', process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par', process.platform === 'linux' ? ['--uid='] : [], 'https://agentclientprotocol.com/get-started/agents', 'Google ACP server and localharness_external are installed together.'), versionProbe: 'handshake' },
  acp('kiro', 'Kiro CLI', 'kiro-cli', ['acp'], 'https://kiro.dev/docs/getting-started/installation/', 'Uses the official Kiro installer and its native ACP interface.'),
  acp('zcode', 'ZCode', 'zcode-acp-server', ['server'], 'https://github.com/william0wang/zcode-acp', 'Community ACP bridge. The official ZCode runtime must also be installed.'),
  acp('trae', 'TRAE CLI', 'traecli', ['acp', 'serve'], 'https://docs.trae.cn/cli_get-started-with-trae-cli-2', 'Uses the official TRAE CLI installer and existing configuration.'),
  acp('command-code', 'Command Code', 'command-code', ['acp'], 'https://commandcode.ai/docs/acp', 'Uses the explicit command-code executable rather than the platform-dependent cmd alias.'),
  acp('minimax', 'MiniMax Code', 'mcode', ['acp'], 'https://github.com/MiniMax-AI/minimax-code#quick-start', 'Native MiniMax Code ACP with the installed CLI configuration.'),
  { ...acp('deepseek-acp', 'DeepSeek Harness · community', 'deepseek-acp', [], 'https://www.npmjs.com/package/deepseek-acp', 'Community editor bridge for DeepSeek Harness; separate from the official dsh ACP profile.'), productId: 'dsh' },
];

const npmPackages: Record<string, string> = {
  codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent', opencode: 'opencode-ai',
  gemini: '@google/gemini-cli', kimi: '@moonshot-ai/kimi-code', qoder: '@qoder-ai/qodercli',
  grok: '@xai-official/grok', cline: 'cline', codebuddy: '@tencent-ai/codebuddy-code',
  openclaw: 'openclaw', zcode: 'zcode-acp-server', 'command-code': 'command-code', 'deepseek-acp': 'deepseek-acp', dsh: '@deepseek-ai/dsh',
};
const installation = (profile: ExternalAgentProfile): ExternalAgentProfile => ({ ...profile,
  installation: npmPackages[profile.id] ? { kind: 'npm', packageName: npmPackages[profile.id]!, ...(['zcode', 'deepseek-acp'].includes(profile.id) ? { community: true } : {}) }
    : ['antigravity', 'cursor'].includes(profile.id) ? { kind: 'archive' } : { kind: 'external' },
});

export const ACP_PROFILES: readonly ExternalAgentProfile[] = [...EXISTING_ACP_PROFILES, ...ADDITIONAL_ACP_PROFILES].map(installation);
export const EXTERNAL_AGENT_PROFILES: readonly ExternalAgentProfile[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', description: 'Codex CLI through its native app-server.', installUrl: 'https://developers.openai.com/codex/cli/', platforms: ['darwin', 'linux', 'win32'], launch: { command: 'codex', args: [] }, versionArgs: ['--version'] },
  { id: 'claude', name: 'Claude Code', harness: 'claude', description: 'Claude Code through the official Agent SDK.', installUrl: 'https://code.claude.com/docs/en/setup', platforms: ['darwin', 'linux', 'win32'], launch: { command: 'claude', args: [] }, versionArgs: ['--version'] },
  { id: 'pi', name: 'Pi', harness: 'pi', description: 'Pi through its native RPC interface.', installUrl: 'https://pi.dev/', platforms: ['darwin', 'linux', 'win32'], launch: { command: 'pi', args: [] }, versionArgs: ['--version'] },
].map(profile => installation(profile as ExternalAgentProfile)).concat(ACP_PROFILES);

export function getExternalAgentProfile(id: string): ExternalAgentProfile | undefined {
  return EXTERNAL_AGENT_PROFILES.find(profile => profile.id === id);
}

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
