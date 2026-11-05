import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/application';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import type { Theme } from '@/types/theme';
import { createVarinMonacoTheme } from '@/lib/monaco/theme';
import light from '@/lib/theme/themes/varin-light.json';
import { useI18nStore, I18nProvider } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { BotPanelBody } from '@/workbenches/bot/BotPanel';
import type { BotPanelModel } from '@/workbenches/bot/botPanelModel';
import { BotWorkspaceNavigationContext, type BotWorkspaceNavigation } from '@/workbenches/bot/botWorkspaceViews';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { DeclarativeUiContent } from '@/components/interactive-ui/DeclarativeUiContent';
import { normalizeConversationUi } from '@varin/application-client';
import { ChatDialogueActivity } from '@/components/conversation/ChatDialogueActivity';
import type { DialogueProcess } from '@/components/conversation/chatDialogueProjection';
import type { ChatToolResultMessage } from '@/components/conversation/types';
import './scenes.css';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') || 'varin';
const zh = params.get('lang') === 'zh-CN';
const text = (en: string, cn: string) => zh ? cn : en;
const theme = light;
const style = document.createElement('style');
style.textContent = `:root { ${new CSSVariableGenerator().generate(theme as Theme)} }`;
document.head.appendChild(style);
await useI18nStore.getState().setLocale(zh ? 'zh-CN' : 'en');

const taskNames = [text('Launch page', '发布页面'), text('Customer feedback', '用户反馈整理'), text('Release notes', '版本说明')];
const noop = () => {};
const identity = { runtime: 'agent' as const, threadId: 'readme-release', branchId: 'main' };
const model = {
  bot: { id: 'readme-varin', name: 'Varin', archived: false, activity: { state: 'awake' } }, figure: 'idle', stage: null,
  line: { key: 'bot.workspace.following', tone: 'neutral' }, session: { identity, running: false }, sessions: [],
  work: taskNames.map((name, i) => ({ key: `work-${i}`, name, task: '', avatar: null,
    identity: { ...identity, threadId: `readme-work-${i}` }, sessionThreadId: identity.threadId, lead: true,
    status: i < 2 ? 'running' : null, lastState: i === 2 ? 'completed' : 'running', updatedAtMs: 0 })),
  workItems: [], needs: [], timeline: [], matters: [], facts: { activity: { status: 'ready', value: { events: [], before: null } }, retryActivity: noop },
  threads: undefined, readOnly: false, busy: false, focus: null, profileOpen: false,
  sessionTitle: () => text('Getting ready for Friday', '准备周五的发布'), focusTab: noop, openWork: noop, openSession: noop,
  openNeed: noop, changeState: noop, archiveMatter: noop, newSession: noop, openProfile: noop, closeProfile: noop,
  onBotChanged: noop, requestDelete: noop, archive: noop,
} as unknown as BotPanelModel;
const navigation = {
  views: [], activeKey: null, focusRevision: 0, error: null,
  sources: { targets: [{ resourceOwner: { kind: 'local' }, label: 'Local' }], unavailable: [] },
  computers: { desktops: [{ id: 'readme-desktop', label: text('My computer', '我的电脑'), status: 'available' }] },
  refresh: noop, open: noop, select: noop, close: noop, files: noop, computer: noop, connections: noop, cite: async () => {},
} as unknown as BotWorkspaceNavigation;
function I({ name, size = 17 }: { name: IconName; size?: number }) { return <Icon name={name} style={{ width: size, height: size, flexShrink: 0 }} />; }
function M({ children }: { children: string }) { return <MarkdownRenderer content={children} />; }
function Row({ icon, children, active = false, end }: { icon: IconName; children: React.ReactNode; active?: boolean; end?: string }) {
  return <div className={`nav-row ${active ? 'selected' : ''}`}><I name={icon} /><span>{children}</span>{end && <small>{end}</small>}</div>;
}
function Header() { return <header className="frame-header">
  <I name="menu-2" /><I name="layout-left" /><span className="mode">{scene === 'varin' || scene === 'conversation' ? <VarinLogo decorative width={17} height={17} /> : <I name={scene === 'workbench' ? 'workbench-agent' : 'code'} />}{scene === 'workbench' ? text('Workbench', '工作台') : scene === 'ide' ? 'IDE' : 'Varin'}<I name="arrow-down-s" size={13} /></span>
  <div className="frame-title">{scene === 'ide' || scene === 'workbench' ? text('A clearer release page', '让发布页面更清晰') : text('Getting ready for Friday', '准备周五的发布')}<small>{scene === 'ide' || scene === 'workbench' ? 'launch-site' : 'Varin'}</small></div>
  <div className="frame-end"><I name="stack" />Local<BotFigure state="idle" size={25} still /><I name="layout-right" /><span className="window-controls">— □ ×</span></div>
</header>; }
function Sidebar() { const bot = scene === 'varin' || scene === 'conversation'; return <aside className="nav">
  <Row icon="chat-new">{text('New conversation', '新建会话')}</Row>
  <Row icon="search">{text('Search', '搜索')}</Row>
  <div className="nav-caption">{bot ? <><BotFigure state="idle" size={28} still />Varin</> : text('Projects', '项目')}</div>
  {!bot && <Row icon="folder">launch-site</Row>}
  <Row icon="chat-3" active>{bot ? text('Friday release', '周五发布准备') : text('A clearer release page', '让发布页面更清晰')}</Row>
  {!bot && <div className="sub-agent"><AgentAvatar identity="accessibility-review" size={21} />{text('Accessibility check', '无障碍检查')}</div>}
  <Row icon="chat-3">{text('Ideas for the next version', '下一版的想法')}</Row>
  <Row icon="chat-3">{text('Notes worth keeping', '值得记住的事')}</Row>
  <div className="nav-bottom"><Row icon="settings-3">{text('Settings', '设置')}</Row></div>
</aside>; }
function Activity({ kind = 'search' }: { kind?: 'search' | 'code' }) {
  const names = kind === 'search' ? ['websearch', 'file_read', 'document_read'] : ['file_edit', 'process_spawn', 'file_edit'];
  const process: DialogueProcess = { kind: 'process', id: `readme-${kind}`, tail: false, activities: names.map((name, i) => ({ kind: 'tool', id: `${kind}-${i}`, sourceId: 'reply', streaming: false, call: { type: 'toolCall', id: `${kind}-${i}`, name, arguments: {} } })) };
  const results = new Map(process.activities.map(a => [a.id, { role: 'toolResult', toolCallId: a.id, toolName: '', content: [], details: { status: 'applied' }, isError: false, timestamp: 0 } as ChatToolResultMessage]));
  return <ChatDialogueActivity process={process} executions={{}} results={results} active={false} renderActivity={() => null} />;
}
function User({ children }: { children: React.ReactNode }) { return <div className="user-message">{children}</div>; }
function Files() { return <div className="file-row"><I name="file-text" /><span>release-notes.md</span><small>Markdown</small><I name="arrow-right-s" size={13} /></div>; }
function Composer({ bot = true }: { bot?: boolean }) { return <div className="composer-wrap"><div className="composer">
  <div className="composer-placeholder">{text('Describe what you want to do…', '描述你想做的事…')}</div>
  <div className="composer-hints">{text('@ Reference files or agents; / Commands and skills', '@ 引用文件或智能体；/ 使用命令和技能')}</div>
  <div className="composer-controls"><I name="add" /><I name="shield-check" />{!bot && <span><I name="folder" />launch-site</span>}<div className="spacer" /><I name="brain" /><small>{text('High', '高')}</small><span>DeepSeek V4.1 Flash</span>{!bot && <small>{text('Coding', '编程')}</small>}<I name="mic" /><span className="send"><I name="arrow-up" /></span></div>
</div></div>; }
const choice = normalizeConversationUi({ type: 'choice', label: text('Who should the release notes speak to first?', '这次版本说明，先面向哪些读者？'),
  options: [text('People trying the product for the first time', '第一次使用产品的新用户'), text('Existing users looking for what changed', '想了解变化的现有用户')], action: text('Use this direction', '按这个方向继续') });
function VarinConversation() { return <section className="conversation"><div className="message-flow rich-flow">
  <User>{text('Let’s get ready for Friday’s release. Help me pull the feedback, release notes and website work together.', '一起准备周五的发布吧。帮我把用户反馈、版本说明和官网的工作统筹起来。')}</User>
  <M>{text('I’ll gather what changed and keep the website work moving alongside it. We can settle the wording here.', '我先把这次变化和反馈整理到一起，官网的修改同时推进。版本说明的表达，我们在这里继续商量。')}</M>
  <Activity />
  <div className="task-pair">{taskNames.slice(0, 2).map((name, i) => <div className="delegate" key={name}><AgentAvatar identity={`readme-work-${i}`} role="lead" size={24} /><b>{name}</b><small>{text('Working', '进行中')}</small><I name="arrow-right-s" size={14} /></div>)}</div>
  <M>{text('### Give people a clear starting point\nThe most useful story is **what someone can do on their first day**. The feature list can follow once they understand that.\n\nI’ve put the notes in one file. We can refine them while the page and feedback review continue.', '### 先让人知道，打开后可以做什么\n这次最值得讲清楚的是**第一次打开就能完成什么**。功能清单可以放在后面，让人先看到使用方式。\n\n我把说明整理成了一个文件。官网页面和反馈整理继续推进，我们可以先完善这份说明。')}</M>
  <Files />
  <DeclarativeUiContent node={choice} sourceKey="readme-audience" />
</div><Composer /></section>; }
function Collaboration() { return <aside className="collaboration"><div className="panel-heading"><I name="chat-3" />{text('Collaboration', '协作')}<div className="spacer" /><I name="fullscreen" /></div>
  <div className="collab-message"><AgentAvatar identity="page-lead" role="lead" size={25} /><div><div className="participants">{text('Page lead', '页面负责人')} <small>→</small> {text('Accessibility check', '无障碍检查')}</div><div className="bubble"><small>{text('Delegated task', '派发任务')}</small><p>{text('Check keyboard navigation, the reading order and both themes. Keep the release page readable on a narrow screen.', '检查键盘导航、阅读顺序和两种主题。确认发布页面在窄屏下依然易读。')}</p><span className="text-link">{text('Open Agent conversation', '查看 Agent 对话')} ›</span></div></div></div>
  <div className="collab-message"><AgentAvatar identity="accessibility-review" size={25} /><div><div className="participants">{text('Accessibility check', '无障碍检查')} <small>→</small> {text('Page lead', '页面负责人')}</div><div className="bubble"><small>{text('Task reply', '任务回复')}</small><p>{text('The layout works in both themes. The comparison links need a visible keyboard focus; I’ve pointed out the two affected elements.', '两种主题下布局都正常。对比区域的链接需要清晰的键盘焦点，我已经标出了涉及的两个元素。')}</p><span className="text-link">{text('Read full reply', '展开全文')}⌄</span></div></div></div>
  <div className="collab-input">{text('Discuss with members or add a request…', '和成员讨论，或补充要求…')}</div>
</aside>; }
function WorkbenchConversation() { return <section className="conversation"><div className="message-flow">
  <User>{text('Make the release page easier to scan. Keep the introduction short, and put the screenshots before the feature list.', '让发布页面更容易阅读。简介短一些，把截图放到功能列表之前。')}</User>
  <M>{text('I’ll adjust the reading order and spacing. A second Agent is checking the keyboard interaction while I work on the page.', '我来调整阅读顺序和间距。另一个 Agent 会同时检查键盘交互。')}</M>
  <Activity kind="code" />
  <M>{text('### The page now starts with the product in use\nThe introduction leads into the screenshots, with a shorter capability overview below. Both themes use the same layout.', '### 先展示产品怎么用\n简介之后直接进入截图，下方再展开精简的能力介绍。亮色和暗色使用同一套布局。')}</M>
  <div className="diff"><div><I name="file-text" />ReleaseSummary.tsx<span className="spacer" /><span className="green">+2</span><span className="red">−1</span></div><pre className="removed">− {'<FeatureList />'}</pre><pre className="added">+ {'<ProductScreenshots />'}</pre><pre className="added">+ {'<FeatureList compact />'}</pre></div>
  <div className="delegate"><AgentAvatar identity="accessibility-review" size={25} /><b>{text('Accessibility check', '无障碍检查')}</b><small>{text('Keyboard, contrast and narrow layouts', '键盘、对比度和窄屏布局')}</small><I name="arrow-right-s" size={15} /></div>
  <M>{text('The feedback is back: two links need clearer focus styling. I’m applying that before the final review.', '检查结果已经回来了：有两处链接需要更清晰的焦点样式。我正在补上，然后再看一遍最终效果。')}</M>
</div><Composer bot={false} /></section>; }
function Chart() { const [series, setSeries] = React.useState('all'); const values = series === 'all' ? [38, 26, 22, 14] : [44, 29, 18, 9]; return <div className="chart">
  <div className="chart-heading"><div><b>{text('What people want to find first', '大家希望先看到什么')}</b><small>{text('Grouped feedback · share of mentions', '反馈归类 · 提及占比')}</small></div><select value={series} onChange={e => setSeries(e.target.value)}><option value="all">{text('All feedback', '全部反馈')}</option><option value="new">{text('New users', '新用户')}</option></select></div>
  {[text('Getting started', '如何开始'), text('Working examples', '实际使用场景'), text('Model support', '模型支持'), text('Deployment', '部署方式')].map((name, i) => <div className="chart-bar" key={name}><span>{name}</span><div><i style={{ width: `${values[i] * 2}%`, opacity: 1 - i * .17 }} /></div><b>{values[i]}%</b></div>)}
  <div className="chart-note">feedback.csv · {text('Group by topic', '按主题归类')}</div>
</div>; }
function RichConversation() { return <section className="conversation"><div className="message-flow rich-flow">
  <User>{text('Which parts of the feedback should shape our introduction? Show me the comparison so we can decide.', '哪些反馈最值得放进简介里？帮我对比一下，我们一起决定。')}</User>
  <Activity />
  <M>{text('### Start with a concrete first task\nThe feedback keeps returning to **how to start** and **what a finished result looks like**. I grouped the comments so you can compare the themes.', '### 从一个具体的首次任务开始\n反馈里反复出现的是**如何开始**和**做完是什么样子**。我把提及的主题整理成了一个可以切换查看的图表。')}</M>
  <Chart />
  <M>{text('A short walkthrough can cover both: ask Varin a question, refine the answer in the conversation, then open the work when you want more detail.', '一段简短的使用过程就能把两件事讲清楚：向 Varin 提出问题，在对话里完善结果，需要细节时再进入正在做的工作。')}</M>
  <div className="sources"><I name="file-text" />feedback.csv<I name="global" />{text('Community discussion', '社区讨论')}<I name="arrow-right-s" size={14} /></div>
  <div className="turn-end"><span><I name="file-copy" /><I name="git-branch" /><I name="more" /></span><small>↓ 8,420 ↑ 1,106 {text('Cache', '缓存率')} 84%</small></div>
</div><Composer /></section>; }
function Editor() { const host = React.useRef<HTMLDivElement>(null); React.useEffect(() => { let editor: { dispose(): void } | undefined; let cancelled = false; void Promise.all([import('monaco-editor/esm/vs/editor/editor.api'), import('monaco-editor/esm/vs/editor/editor.worker?worker'), import('monaco-editor/esm/vs/languages/definitions/typescript/register.js')]).then(([monaco, worker]) => {
    if (cancelled || !host.current) return;
    (globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new worker.default() };
    monaco.editor.defineTheme('readme-varin', createVarinMonacoTheme(light as Theme));
    editor = monaco.editor.create(host.current, { value: `import { ProductScreenshots } from './ProductScreenshots';\nimport { FeatureList } from './FeatureList';\n\nexport function ReleaseSummary() {\n  return (\n    <main className="release-page">\n      <header className="release-introduction">\n        <p className="eyebrow">Meet your new workspace</p>\n        <h1>Talk to Varin. Keep your work moving.</h1>\n        <p>\n          Start with a conversation. Open the work\n          whenever you want to take a closer look.\n        </p>\n      </header>\n\n      <ProductScreenshots />\n      <FeatureList compact />\n\n      <a className="download-link" href="/download">\n        Get started\n      </a>\n    </main>\n  );\n}\n`, language: 'typescript', theme: 'readme-varin', fontSize: 15, lineHeight: 26, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 22 }, readOnly: false });
    document.body.dataset.editorReady = 'true';
  }); return () => { cancelled = true; editor?.dispose(); }; }, []); return <div className="editor-area"><div className="editor-tabs"><span><I name="file-code" />ReleaseSummary.tsx ×</span><span>release.css</span></div><div ref={host} className="monaco-host" /><div className="terminal"><div>{text('Terminal', '终端')} <span>{text('Problems', '问题')} 0</span></div><pre>$ bun run build<br /><span className="green">✓</span> {text('Build completed', '构建完成')}<br />$ <span className="cursor">▌</span></pre></div></div>; }
function IdeChat() { return <div className="ide-chat"><div className="panel-heading"><I name="chat-3" />{text('Conversation', '对话')}</div><User>{text('The order looks good. Keep the focus styles consistent with the rest of the site.', '顺序看着不错，焦点样式也和站点其他部分保持一致。')}</User><M>{text('I’ll reuse the existing focus treatment. The content order stays as we agreed.', '我会复用已有的焦点样式，内容顺序保持刚才商量的版本。')}</M><Activity kind="code" /><M>{text('The changes are in `ReleaseSummary.tsx` and `release.css`. You can edit the files here while we keep discussing the page.', '改动在 `ReleaseSummary.tsx` 和 `release.css`。你可以直接在这里编辑，我们继续讨论页面。')}</M><Files /><Composer bot={false} /></div>; }
export function App() { return <I18nProvider><div className={`readme-app ${scene}`}><Header /><div className="frame-body">{(scene === 'workbench' || scene === 'ide') && <Sidebar />}{scene === 'varin' ? <><VarinConversation /><aside className="bot-area"><BotWorkspaceNavigationContext.Provider value={navigation}><BotPanelBody model={model} /></BotWorkspaceNavigationContext.Provider></aside></> : scene === 'workbench' ? <><WorkbenchConversation /><Collaboration /></> : scene === 'ide' ? <><Editor /><IdeChat /></> : <RichConversation />}</div></div></I18nProvider>; }
createRoot(document.getElementById('root')!).render(<App />);
document.body.dataset.readmeReady = 'true';
