/** Design inventory, not the production registry. See SUPPORT.md for evidence and outstanding work. */
export type Product = {
  id: string;
  name: string;
  harness: 'codex' | 'claude' | 'pi' | 'acp';
  description: string;
  version: string;
  command: string;
  args: string[];
  installation: 'managed' | 'official';
  guide?: string;
  note?: string;
  mark?: string;
  darkMark?: string;
  route?: 'official' | 'community';
};

// Versions illustrate the inspected reference builds; this is not a live release catalogue.
export const products: Product[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', description: '使用 Codex CLI，沿用已有的程序配置。', version: '0.167.0', command: 'codex', args: ['app-server'], installation: 'managed' },
  { id: 'claude', name: 'Claude Code', harness: 'claude', description: '沿用 Claude Code 的工具与项目配置。', version: '2.1.59', command: 'claude', args: [], installation: 'official', guide: 'https://code.claude.com/docs/en/setup' },
  { id: 'opencode', name: 'OpenCode', harness: 'acp', description: '连接 OpenCode，沿用自己的模型服务。', version: '2.3.0', command: 'opencode', args: ['acp'], installation: 'managed' },
  { id: 'pi', name: 'Pi', harness: 'pi', description: '轻量、可扩展的编码 Agent。', version: '1.5.0', command: 'pi', args: ['--mode', 'rpc'], installation: 'managed' },
  { id: 'gemini', name: 'Gemini CLI', harness: 'acp', description: '在终端与工作区中使用 Gemini。', version: '0.60.0', command: 'gemini', args: ['--acp'], installation: 'managed' },
  { id: 'kimi', name: 'Kimi Code', harness: 'acp', description: '连接 Kimi Code 的原生 ACP 接口。', version: '2.6.2', command: 'kimi', args: ['acp'], installation: 'managed' },
  { id: 'cursor', name: 'Cursor Agent', harness: 'acp', description: '使用 Cursor CLI 的模型与项目能力。', version: '2026.11.13-eacade1', command: 'cursor-agent', args: ['acp'], installation: 'managed' },
  { id: 'qoder', name: 'Qoder', harness: 'acp', description: '通过 Qoder CLI 在项目中开展工作。', version: '1.1.89', command: 'qoder', args: ['--acp'], installation: 'managed', mark: 'qoder', darkMark: 'qoder-dark' },
  { id: 'grok', name: 'Grok', harness: 'acp', description: '连接 Grok 的终端 Agent。', version: '1.0.77', command: 'grok', args: ['agent', 'stdio'], installation: 'managed', mark: 'grok', darkMark: 'grok-dark' },
  { id: 'dsh', name: 'DeepSeek Harness', harness: 'acp', description: '官方 Harness，可选面向编辑器的社区桥接。', version: '0.2.2-rc.3', command: 'dsh', args: ['--profile', 'acp'], installation: 'managed', mark: 'deepseek-harness', route: 'official' },
  { id: 'cline', name: 'Cline', harness: 'acp', description: '在项目中使用 Cline CLI 的原生工具。', version: '3.0.74', command: 'cline', args: ['--acp'], installation: 'managed', mark: 'cline', darkMark: 'cline-dark' },
  { id: 'codebuddy', name: 'CodeBuddy', harness: 'acp', description: '接入腾讯 CodeBuddy 的终端 Agent。', version: '2.184.0', command: 'codebuddy', args: ['--acp'], installation: 'managed', mark: 'codebuddy', darkMark: 'codebuddy-dark' },
  { id: 'openclaw', name: 'OpenClaw', harness: 'acp', description: '连接你已部署的 OpenClaw 助手。', version: '2026.9.8', command: 'openclaw', args: ['acp'], installation: 'managed', mark: 'openclaw', note: '还需要已配置的 OpenClaw Gateway。沿用该设备的 OpenClaw 连接设置；安装 CLI 不会部署 Gateway。' },
  { id: 'hermes', name: 'Hermes Agent', harness: 'acp', description: '连接 Nous Research 的长期助手。', version: '0.23.1', command: 'hermes', args: ['acp'], installation: 'official', guide: 'https://github.com/NousResearch/hermes-agent', mark: 'hermes-agent', darkMark: 'hermes-agent-dark', note: '优先连接通过官方安装器安装的 Hermes。codeg 使用的 npm 分发包装由社区维护，安装渠道需明确区分。' },
  { id: 'antigravity', name: 'Google Antigravity', harness: 'acp', description: '通过 Google 提供的 ACP 服务接入。', version: '1.5.0', command: 'agy_acp_server', args: [], installation: 'managed', mark: 'google-antigravity', darkMark: 'google-antigravity-dark', note: '安装包含 ACP 服务及配套 Harness 的完整发行目录。已有程序应选择该目录里的实际可执行入口。' },
  { id: 'kiro', name: 'Kiro CLI', harness: 'acp', description: '沿用 Kiro 的 Agent 配置与项目能力。', version: '2.24.1', command: 'kiro-cli', args: ['acp'], installation: 'official', guide: 'https://kiro.dev/docs/getting-started/installation/', mark: 'kiro' },
  { id: 'zcode', name: 'ZCode', harness: 'acp', description: '通过社区 ACP 桥接连接 ZCode。', version: '0.85.2', command: 'zcode-acp-server', args: ['server'], installation: 'managed', mark: 'zcode', note: '这里安装 zcode-acp-server 社区桥接。目标设备还需要官方 ZCode 程序，继续使用其原有配置。' },
  { id: 'trae', name: 'TRAE CLI', harness: 'acp', description: '接入 TRAE CLI 的原生 ACP 服务。', version: '0.209.1', command: 'traecli', args: ['acp', 'serve'], installation: 'official', guide: 'https://docs.trae.cn/cli_get-started-with-trae-cli-2', mark: 'trae' },
  { id: 'command-code', name: 'Command Code', harness: 'acp', description: '使用 Command Code 的工具、技能与会话。', version: '1.89.1', command: 'command-code', args: ['acp'], installation: 'managed', mark: 'command-code' },
  { id: 'minimax', name: 'MiniMax Code', harness: 'acp', description: '连接 MiniMax 的终端编码 Agent。', version: '0.7.2', command: 'mcode', args: ['acp'], installation: 'official', guide: 'https://github.com/MiniMax-AI/minimax-code#quick-start', mark: 'minimax-code' },
];

/** One product, two explicit connection choices. Existing bindings are not silently converted. */
export function deepseekRoute(product: Product, route: 'official' | 'community'): Product {
  return { ...product, route,
    command: route === 'official' ? 'dsh' : 'deepseek-acp',
    args: route === 'official' ? ['--profile', 'acp'] : [],
    version: route === 'official' ? '0.2.2-rc.3' : '0.11.0',
  };
}

export const productMarks = import.meta.glob<string>('./assets/*.svg', { eager: true, query: '?url', import: 'default' });
