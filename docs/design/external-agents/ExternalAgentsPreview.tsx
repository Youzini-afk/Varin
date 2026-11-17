import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { HarnessIcon } from '@/components/thread/HarnessIcon';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { I18nContext } from '@/lib/i18n/react-context';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import type { Theme } from '@/types/theme';
import light from '@/lib/theme/themes/varin-light.json';
import dark from '@/lib/theme/themes/varin-dark.json';
import './preview.css';

// Synthetic fixtures only. No Host, filesystem, installer, auth or model APIs.
type Product = { id: string; name: string; harness: 'codex' | 'claude' | 'pi' | 'acp'; description: string; version: string; command: string };
type Agent = Product & { source: 'system' | 'managed'; phase: 'installed' | 'missing' | 'installing' | 'failed'; enabled: boolean; progress?: number };
const products: Product[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', description: '使用 Codex CLI，沿用已有的程序配置。', version: '0.167.0', command: 'codex' },
  { id: 'claude', name: 'Claude Code', harness: 'claude', description: '沿用 Claude Code 的工具与项目配置。', version: '2.1.59', command: 'claude' },
  { id: 'opencode', name: 'OpenCode', harness: 'acp', description: '连接 OpenCode，沿用自己的模型服务。', version: '2.2.0', command: 'opencode' },
  { id: 'pi', name: 'Pi', harness: 'pi', description: '轻量、可扩展的编码 Agent。', version: '1.5.0', command: 'pi' },
  { id: 'gemini', name: 'Gemini CLI', harness: 'acp', description: '在终端与工作区中使用 Gemini。', version: '0.60.0', command: 'gemini' },
  { id: 'kimi', name: 'Kimi Code', harness: 'acp', description: '连接 Kimi Code 的原生 ACP 接口。', version: '2.4.0', command: 'kimi' },
  { id: 'cursor', name: 'Cursor Agent', harness: 'acp', description: '使用 Cursor CLI 的模型与项目能力。', version: '2026.10.22', command: 'cursor-agent' },
];
const initialAgents = (): Agent[] => products.slice(0, 4).map((p, i) => ({ ...p, source: i === 2 ? 'managed' : 'system', phase: 'installed', enabled: i !== 3 }));
const deviceNames = { local: '工作电脑', remote: '开发服务器' };
const themeGenerator = new CSSVariableGenerator();
const i18n = { locale: 'zh-CN' as const, locales: ['zh-CN'] as const, setLocale: () => {}, label: () => '简体中文', t: (key: string) => key.toLowerCase().includes('close') ? '关闭' : key };
const icon = (name: IconName, className = '') => <Icon name={name} className={`size-4 ${className}`} />;
const logo = (p: Product, large = false) => <HarnessIcon harness={p.harness} configurationId={p.id} className={large ? 'size-9' : 'size-6'} />;
const phaseText = (a: Agent) => !a.enabled ? '已停用' : a.phase === 'missing' ? '未安装' : a.phase === 'failed' ? '安装未完成' : a.phase === 'installing' ? '正在安装' : a.version;
const sourceText = (a: Agent) => a.source === 'managed' ? 'Varin 管理' : '已有程序';

function Choice({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange(value: string): void }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="choice-trigger"><SelectValue /></SelectTrigger><SelectContent>{values.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select>;
}
function AgentDetail({ agent, device, patch, install, onRemove }: {
  agent: Agent; device: string; patch(value: Partial<Agent>): void; install(agent: Agent): void; onRemove(): void;
}) {
  const [model, setModel] = useState('沿用 Agent 配置');
  const [thinking, setThinking] = useState('沿用 Agent 配置');
  const [mode, setMode] = useState('沿用 Agent 配置');
  const [command, setCommand] = useState(agent.command);
  const [args, setArgs] = useState(agent.harness === 'acp' ? ['acp'] : agent.harness === 'codex' ? ['app-server'] : []);
  const [saved, setSaved] = useState(false);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [version, setVersion] = useState('最新稳定版');
  const [checked, setChecked] = useState(false);
  const busy = agent.phase === 'installing';
  const missing = ['missing', 'failed'].includes(agent.phase);
  const p = agent.progress ?? 0;
  const stage = p < 55 ? '正在下载' : p < 85 ? '正在安装' : '正在检测程序';
  return <SettingsPageLayout title={<div className="product-title">{logo(agent, true)}<div><h1>{agent.name}</h1><p>{agent.description}</p></div></div>}
    headerEnd={<DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="Agent 更多操作">{icon('more')}</Button></DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onClick={() => setSourcePicker(true)}>切换程序来源</DropdownMenuItem>
      <DropdownMenuItem onClick={() => patch({ enabled: !agent.enabled })}>{agent.enabled ? '在 Varin 中停用' : '在 Varin 中启用'}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive" onClick={onRemove}>{agent.source === 'managed' ? '卸载程序…' : '移除接入…'}</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>} className="agent-detail-page">
    <SettingsSection divider={false} title="程序" headerAction={<span className="quiet-inline">{icon(device === 'local' ? 'computer' : 'server')}{deviceNames[device as keyof typeof deviceNames]}</span>}>
      <div className="program-line"><div className="program-summary"><span className="program-version">{missing ? '未安装' : busy ? stage : agent.version}</span><span className="text-muted-foreground">{sourceText(agent)}</span>{!agent.enabled && <span className="subtle-tag">已停用</span>}</div>
        <div className="program-actions">{busy ? <Button variant="outline" size="sm" onClick={() => patch({ phase: 'missing', progress: undefined })}>取消</Button> : <>
          {!missing && <Button size="sm" variant="ghost" onClick={() => setSourcePicker(!sourcePicker)}>切换来源</Button>}
          <Button variant={missing ? 'default' : 'outline'} size="sm" onClick={() => missing ? install(agent) : setChecked(true)}>{icon(missing ? 'download' : 'refresh')}{missing ? '安装' : '检查更新'}</Button>
        </>}</div>
      </div>
      {checked && !busy && <p className="mt-3 text-xs text-muted-foreground" role="status">已是最新稳定版。</p>}
      <AnimatePresence initial={false}>{sourcePicker && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="source-picker">
        <p>选择这台设备上的程序</p>
        {(['system', 'managed'] as const).map(source => <button className="source-option" key={source} onClick={() => { if (source === 'managed' && agent.source !== 'managed') install(agent); else patch({ source }); setSourcePicker(false); }}>
          {icon(source === 'system' ? 'folder' : 'download')}<span>{source === 'system' ? '使用已有程序' : '由 Varin 管理'}<small>{source === 'system' ? '沿用这台设备上的安装' : '单独安装，版本可在这里维护'}</small></span>{agent.source === source && icon('check')}
        </button>)}
      </motion.div>}</AnimatePresence>
      {busy && <div className="install-progress" aria-live="polite"><div className="progress-caption"><span>{stage}{p < 55 ? ' · 获取发行包' : p < 85 ? ' · 准备运行环境' : ''}</span><span>{p}%</span></div><div className="progress-track"><div style={{ width: `${p}%` }} /></div><p>可以离开此页，安装会在{deviceNames[device as keyof typeof deviceNames]}上继续。</p></div>}
      {agent.phase === 'failed' && <div className="operation-error" role="alert"><div>{icon('error-warning')}<span>下载中断，程序尚未安装。</span></div><Button size="sm" variant="ghost" onClick={() => install(agent)}>重试</Button></div>}
      {(busy || agent.phase === 'failed') && <details className="operation-log"><summary>查看安装日志 {icon('arrow-down-s')}</summary><pre>{`> 获取 ${agent.name} ${agent.version}\n${agent.phase === 'failed' ? '下载连接已断开 (ECONNRESET)\n安装目录尚未切换。' : p < 55 ? '正在下载发行包…' : p < 85 ? '下载完成。\n正在准备程序文件…' : '程序文件已就绪。\n检查启动版本…'}`}</pre></details>}
      {!busy && !missing && <details className="program-location"><summary>查看程序位置 {icon('arrow-down-s')}</summary><code>{agent.source === 'managed' ? `Varin 数据目录 / agents / ${agent.id} / ${agent.version}` : device === 'remote' ? `/usr/local/bin/${agent.command}` : `%USERPROFILE% / .local / bin / ${agent.command}.exe`}</code></details>}
    </SettingsSection>
    {!missing && !busy && <SettingsSection title="新会话默认值" description="未指定时，使用 Agent 自身配置。">
      <SettingsFieldRow label="模型"><Choice label="模型" value={model} values={['沿用 Agent 配置', agent.harness === 'claude' ? 'Claude Sonnet' : 'GPT-6', agent.harness === 'claude' ? 'Claude Opus' : 'GPT-6 mini']} onChange={setModel} /></SettingsFieldRow>
      <SettingsFieldRow label="思考强度"><Choice label="思考强度" value={thinking} values={['沿用 Agent 配置', '低', '中', '高']} onChange={setThinking} /></SettingsFieldRow>
      <SettingsFieldRow label="执行模式"><Choice label="执行模式" value={mode} values={['沿用 Agent 配置', '默认', '只读']} onChange={setMode} /></SettingsFieldRow>
    </SettingsSection>}
    <details className="settings-disclosure advanced"><summary>{icon('arrow-right-s', 'settings-disclosure-chevron')}<span>高级设置</span><span className="ml-auto text-muted-foreground">启动方式与版本</span></summary><div className="settings-disclosure-body">
      <SettingsFieldRow label="在 Varin 中使用"><Switch aria-label="在 Varin 中使用" checked={agent.enabled} onCheckedChange={enabled => patch({ enabled })} /></SettingsFieldRow>
      <SettingsFieldRow label="安装版本"><Choice label="安装版本" value={version} values={['最新稳定版', agent.version, '指定版本…']} onChange={setVersion} /></SettingsFieldRow>
      {version === '指定版本…' && <Input aria-label="指定版本号" placeholder="例如 1.5.0" />}
      <label className="advanced-field">程序路径<Input value={command} onChange={e => { setCommand(e.target.value); setSaved(false); }} /></label>
      <label className="advanced-field">启动参数<div className="argument-inputs">{args.map((arg, i) => <span key={i}><Input aria-label={`启动参数 ${i + 1}`} value={arg} onChange={e => setArgs(args.map((v, n) => n === i ? e.target.value : v))} /><Button size="icon" variant="ghost" aria-label={`移除参数 ${i + 1}`} onClick={() => setArgs(args.filter((_, n) => n !== i))}>{icon('close')}</Button></span>)}<Button size="sm" variant="ghost" onClick={() => setArgs([...args, ''])}>{icon('add')}添加参数</Button></div></label>
      <Button variant="outline" size="sm" onClick={() => { patch({ command }); setSaved(true); }}>{saved ? <>{icon('check')}已保存</> : '保存启动配置'}</Button>
    </div></details>
  </SettingsPageLayout>;
}

export function ExternalAgentsPreview() {
  const params = new URLSearchParams(location.search);
  const [theme, setTheme] = useState(params.get('theme') === 'dark' ? 'dark' : 'light');
  const [narrow, setNarrow] = useState(false);
  const [device, setDevice] = useState<'local' | 'remote'>('local');
  const [agentsByDevice, setAgentsByDevice] = useState<Record<string, Agent[]>>({ local: initialAgents(), remote: [{ ...products[0], phase: 'installed', source: 'system', enabled: true }] });
  const [selected, setSelected] = useState<string | null>(params.get('view') === 'detail' ? 'opencode' : null);
  const [addOpen, setAddOpen] = useState(params.get('view') === 'add');
  const [query, setQuery] = useState('');
  const [candidate, setCandidate] = useState<Product | null>(null);
  const [installSource, setInstallSource] = useState('由 Varin 安装');
  const [custom, setCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [remove, setRemove] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const agents = agentsByDevice[device];
  const active = agents.find(a => a.id === selected);
  useEffect(() => themeGenerator.apply((theme === 'dark' ? dark : light) as Theme), [theme]);
  useEffect(() => {
    const timer = setInterval(() => setAgentsByDevice(current => {
      if (!Object.values(current).some(list => list.some(a => a.phase === 'installing'))) return current;
      return Object.fromEntries(Object.entries(current).map(([key, list]) => [key, list.map(a => a.phase !== 'installing' ? a : (a.progress ?? 0) >= 96 ? { ...a, phase: 'installed', progress: undefined } : { ...a, progress: (a.progress ?? 0) + 4 })]));
    }), 240);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3200); return () => clearTimeout(timer); }, [notice]);
  const patch = (id: string, values: Partial<Agent>) => setAgentsByDevice(current => ({ ...current, [device]: current[device].map(a => a.id === id ? { ...a, ...values } : a) }));
  const upsert = (agent: Agent) => setAgentsByDevice(current => ({ ...current, [device]: current[device].some(a => a.id === agent.id) ? current[device].map(a => a.id === agent.id ? agent : a) : [...current[device], agent] }));
  const install = (agent: Agent) => { upsert({ ...agent, source: 'managed', phase: 'installing', progress: 0, enabled: true }); setSelected(agent.id); setAddOpen(false); };
  const openCatalog = () => { setQuery(''); setCandidate(null); setCustom(false); setAddOpen(true); };
  const scene = (value: string) => {
    setAddOpen(false); setSelected(null);
    if (value === '管理') setSelected('codex');
    if (value === '添加') openCatalog();
    if (value === '安装失败') { const a: Agent = { ...products[4], source: 'managed', enabled: true, phase: 'failed' }; upsert(a); setSelected(a.id); }
  };
  const switchDevice = (value: string) => { setDevice(value as 'local' | 'remote'); setSelected(null); setNotice(''); };
  const listRows = (list: Agent[]) => list.map(agent => <div key={agent.id} className={`agent-row ${!agent.enabled ? 'is-disabled' : ''}`}>
    <button className="agent-row-main" onClick={() => setSelected(agent.id)} aria-label={`管理 ${agent.name}`}><span className="product-mark">{logo(agent)}</span><span className="agent-copy"><span className="agent-name">{agent.name}</span><span className="agent-meta"><span className={agent.phase === 'failed' ? 'text-destructive' : ''}>{phaseText(agent)}</span>{agent.phase !== 'missing' && <><span className="meta-dot">·</span>{sourceText(agent)}</>}</span></span></button>
    <div className="agent-row-actions">{agent.phase === 'installing' && icon('loader-4', 'animate-spin text-muted-foreground')}
      <Button size="icon" variant="ghost" aria-label={`查看 ${agent.name}`} onClick={() => setSelected(agent.id)}>{icon('arrow-right-s')}</Button>
    </div>
  </div>);
  return <I18nContext.Provider value={i18n}><div className="preview-root">
    <header className="review-toolbar"><div><strong>外部 Agent</strong><span>交互设计稿 · 示例数据</span></div><div className="review-scenes"><Choice label="预览场景" value={addOpen ? '添加' : active?.phase === 'failed' ? '安装失败' : selected ? '管理' : '概览'} values={['概览', '管理', '添加', '安装失败']} onChange={scene} /><Button variant="ghost" size="sm" aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>{icon('computer')}{narrow ? '宽屏' : '窄屏'}</Button><Button variant="ghost" size="sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{icon('moon')}{theme === 'dark' ? '浅色' : '深色'}</Button></div></header>
    <div className={`settings-frame corner-continuous ${narrow ? 'narrow' : ''}`}>
      <aside className="settings-sidebar"><div className="sidebar-search">{icon('search')}<span>搜索设置</span></div><div className="nav-label">常规</div><div className="nav-item">{icon('settings-3')}通用</div><div className="nav-item">{icon('computer')}外观</div><div className="nav-label agent-group">AGENT</div><div className="nav-item">{icon('cloud')}模型服务</div><div className="nav-item">{icon('robot-2')}agents</div><div className="nav-item selected" aria-current="page">{icon('terminal')}外部 Agent</div><div className="nav-item">{icon('robot')}Varin</div><div className="nav-item">{icon('code')}系统提示词</div><div className="nav-item">{icon('file-text')}记忆</div><div className="nav-item">{icon('computer')}Computer Use</div><div className="nav-item">{icon('global')}浏览器</div><div className="nav-label agent-group">设备与连接</div><div className="nav-item">{icon('server')}工作连接</div><div className="sidebar-bottom">{icon('information')}关于</div></aside>
      <main className="settings-main"><div className="breadcrumb"><span>Agent</span>{icon('arrow-right-s')}<button onClick={() => setSelected(null)}>外部 Agent</button>{active && <>{icon('arrow-right-s')}<span className="text-foreground">{active.name}</span></>}<span className="breadcrumb-end">{icon(device === 'local' ? 'computer' : 'server')}{deviceNames[device]}</span></div>
        <div className="page-stage"><AnimatePresence mode="popLayout" initial={false}><motion.div key={`${device}:${selected ?? 'list'}`} className="page-scene" initial={{ opacity: 0, x: selected ? 10 : -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: selected ? -6 : 6 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }}>
          {active ? <><div className="detail-back"><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>{icon('arrow-left')}外部 Agent</Button></div><div className="detail-scroll"><AgentDetail key={`${device}:${active.id}`} agent={active} device={device} patch={values => patch(active.id, values)} install={install} onRemove={() => setRemove(true)} /></div></> : <SettingsPageLayout title="外部 Agent" description="在所选设备上，使用和管理你常用的 Agent。" headerEnd={<Button size="sm" onClick={openCatalog}>{icon('add')}添加 Agent</Button>}>
            <div className="device-bar"><div className="device-picker"><span className="device-symbol">{icon(device === 'local' ? 'computer' : 'server')}</span><div><Select value={device} onValueChange={switchDevice}><SelectTrigger aria-label="执行设备" className="device-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">工作电脑</SelectItem><SelectItem value="remote">开发服务器</SelectItem></SelectContent></Select><p>{device === 'local' ? '当前 Varin 服务 · Windows' : '已连接 · Linux'}</p></div></div><Button variant="ghost" size="sm" onClick={() => { setRefreshing(true); setTimeout(() => { setRefreshing(false); setNotice('检测完成，程序列表已更新'); }, 900); }}>{icon('refresh', refreshing ? 'animate-spin' : '')}{refreshing ? '检测中' : '重新检测'}</Button></div>
            <section className="agent-list"><div className="list-caption">已接入</div>{listRows(agents.filter(a => a.enabled))}</section>
            {agents.some(a => !a.enabled) && <details className="disabled-agents"><summary>{icon('arrow-right-s')}已停用<span>{agents.filter(a => !a.enabled).length}</span></summary>{listRows(agents.filter(a => !a.enabled))}</details>}
            <button className="catalog-entry" onClick={openCatalog}><span className="catalog-symbol">{icon('add')}</span><span><strong>接入更多 Agent</strong><small>安装新的产品，或连接已有的 ACP 程序。</small></span>{icon('arrow-right')}</button>
          </SettingsPageLayout>}
        </motion.div></AnimatePresence></div>
      </main>
    </div>
    <footer className="review-footer"><span>真实设置组件 · Varin 主题与产品图标</span><span>点击列表或添加，体验安装与管理。</span></footer>
    <AnimatePresence>{notice && <motion.div className="preview-notice" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}>{icon('check')}{notice}</motion.div>}</AnimatePresence>
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="catalog-dialog"><DialogHeader><DialogTitle>{custom ? '自定义 ACP Agent' : candidate ? `添加 ${candidate.name}` : '添加 Agent'}</DialogTitle><DialogDescription>安装与连接将在{deviceNames[device]}上进行。</DialogDescription></DialogHeader>
      {custom ? <div className="custom-fields"><label>名称<Input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="例如 My Agent" /></label><label>程序路径<Input value={customPath} onChange={e => setCustomPath(e.target.value)} placeholder="可执行程序或完整路径" /></label><p>添加后可在高级设置中编辑启动参数。</p><div className="dialog-actions"><Button variant="ghost" onClick={() => setCustom(false)}>返回</Button><Button disabled={!customName.trim() || !customPath.trim()} onClick={() => { const a: Agent = { id: `custom-${Date.now()}`, name: customName, harness: 'acp', description: '自定义 ACP 程序。', command: customPath, version: '', source: 'system', enabled: true, phase: 'missing' }; upsert(a); setSelected(a.id); setAddOpen(false); }}>添加并检测</Button></div></div>
      : candidate ? <div className="candidate-detail"><div className="candidate-brand">{logo(candidate, true)}<div><strong>{candidate.name}</strong><p>{candidate.description}</p></div></div>
        <div className="install-options">{['由 Varin 安装', '选择已有程序'].map(value => <button key={value} className="install-option" aria-pressed={installSource === value} onClick={() => setInstallSource(value)}><span className="choice-radio">{installSource === value && <span />}</span><span>{value}<small>{value === '由 Varin 安装' ? '安装到该设备的 Varin 数据目录，方便更新和移除。' : '连接你已安装的程序，保留其原有配置。'}</small></span></button>)}</div>
        {installSource === '由 Varin 安装' ? <div className="install-version"><span>安装版本</span><span>{candidate.version}<span className="text-muted-foreground"> · 稳定版</span></span></div> : <Input aria-label="已有程序路径" value={customPath} onChange={e => setCustomPath(e.target.value)} placeholder={candidate.command} />}
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setCandidate(null)}>返回</Button><Button onClick={() => { const a: Agent = { ...candidate, source: installSource === '由 Varin 安装' ? 'managed' : 'system', enabled: true, phase: 'installed', command: customPath || candidate.command }; if (installSource === '由 Varin 安装') install(a); else { upsert(a); setSelected(a.id); setAddOpen(false); } }}>{icon(installSource === '由 Varin 安装' ? 'download' : 'check')}{installSource === '由 Varin 安装' ? '安装' : '连接程序'}</Button></div>
      </div> : <><div className="catalog-search">{icon('search')}<Input aria-label="搜索 Agent" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 Agent" /></div><div className="catalog-products">{products.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase())).map(p => { const exists = agents.some(a => a.id === p.id); return <button key={p.id} className="catalog-product" onClick={() => { if (exists) { setSelected(p.id); setAddOpen(false); } else { setCandidate(p); setInstallSource('由 Varin 安装'); setCustomPath(''); } }}>{logo(p)}<span><strong>{p.name}</strong><small>{p.description}</small></span>{exists ? <span className="catalog-connected">已接入</span> : icon('add')}</button>; })}{!products.some(p => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase())) && <p className="no-results">没有匹配的产品，可以添加自定义 ACP 程序。</p>}</div><button className="custom-entry" onClick={() => { setCustom(true); setCustomName(''); setCustomPath(''); }}>{icon('terminal')}自定义 ACP Agent{icon('arrow-right-s', 'ml-auto')}</button></>}
    </DialogContent></Dialog>
    <Dialog open={remove} onOpenChange={setRemove}><DialogContent><DialogHeader><DialogTitle>{active?.source === 'managed' ? `卸载 ${active.name}？` : `移除 ${active?.name} 接入？`}</DialogTitle><DialogDescription>{active?.source === 'managed' ? `移除${deviceNames[device]}上由 Varin 安装的程序。会话记录和 Agent 账号配置会保留。` : '移除 Varin 中的接入配置，保留设备上的程序与会话记录。'}</DialogDescription></DialogHeader><div className="dialog-actions"><Button variant="ghost" onClick={() => setRemove(false)}>取消</Button><Button variant="destructive" onClick={() => { setAgentsByDevice(current => ({ ...current, [device]: current[device].filter(a => a.id !== selected) })); setRemove(false); setSelected(null); }}>{active?.source === 'managed' ? '卸载程序' : '移除接入'}</Button></div></DialogContent></Dialog>
  </div></I18nContext.Provider>;
}
