/* Offline interaction specification. No fetch, IPC, credential storage or runtime mutation. */
'use strict';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
 sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5.5 5.5 7 7m10 10 1.5 1.5m0-13L17 7M7 17l-1.5 1.5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 chat:'M4 4h16v12H8l-4 4zM8 8h8m-8 4h5', clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
 bell:'M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 20h4', mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 11v1a7 7 0 0 0 14 0v-1M12 19v3',
 keyboard:'M3 5h18v14H3zM6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10',
 database:'M20 6c0 2-16 2-16 0s16-2 16 0M4 6v12c0 3 16 3 16 0V6M4 12c0 3 16 3 16 0',
 cloud:'M6 18a5 5 0 1 1 1-10 6 6 0 0 1 11 1 4.5 4.5 0 1 1 0 9z',
 agent:'M5 7h14v12H5zM9 11v2m6-2v2m-6 3h6M12 3v4M2 11v4m20-4v4',
 doc:'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8m-8 4h6',
 brain:'M9 4a3 3 0 0 0-5 2 4 4 0 0 0-1 7 4 4 0 0 0 6 6V4zm6 0a3 3 0 0 1 5 2 4 4 0 0 1 1 7 4 4 0 0 1-6 6V4z',
 terminal:'m4 5 6 6-6 6m9 0h7', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-6 6-6 12 0 18 6-6 6-12 0-18',
 image:'M3 3h18v18H3zM7 8h.1M3 17l6-6 4 4 3-3 5 5', monitor:'M3 4h18v13H3zM8 21h8m-4-4v4',
 shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6',
 layers:'m12 3 10 5-10 5L2 8zm-9 9 9 5 9-5m-18 5 9 5 9-5',
 folder:'M3 6h7l2 3h9v11H3z', code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
 git:'M7 3v12a4 4 0 0 0 8 0V9M7 3a2 2 0 1 0 .01 0M15 5a2 2 0 1 0 .01 0M7 17a2 2 0 1 0 .01 0',
 search:'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0m-2 5 6 6',
 plug:'M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-14 0zm7 10v4',
 link:'M9 15 15 9M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1',
 arrow:'m9 5 7 7-7 7', back:'m15 5-7 7 7 7', check:'m5 12 5 5L20 7', plus:'M12 4v16M4 12h16',
 refresh:'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1M19 17A8 8 0 0 1 5 18',
 edit:'m15 3 6 6-12 12H3v-6zM12 6l6 6', trash:'M4 6h16M9 3h6M6 6l1 15h10l1-15M10 10v7m4-7v7',
 info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6m0-10h.01',
 bolt:'M13 2 5 14h6l-1 8 9-13h-6z', key:'M14 10a5 5 0 1 1-10 0 5 5 0 0 1 10 0m0 0h8m-3 0v3m3-3v2',
 sound:'M3 9h4l5-4v14l-5-4H3zM16 8c2 3 2 5 0 8m3-11c4 5 4 9 0 14',
 box:'m12 2 9 5v10l-9 5-9-5V7zm-9 5 9 5 9-5m-9 5v10', eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
};
const icon = name => `<svg class="i" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.settings}"/></svg>`;
const logo = (name, cls='') => `<img class="provider-logo ${cls}" data-provider="${name}" src="../../packages/ui/src/assets/provider-logos/${name}.svg" alt="">`;
const btn = (label, action, type='', glyph='') => `<button class="btn ${type}" data-action="${action}">${glyph ? icon(glyph) : ''}${label}</button>`;
const route = (label, page) => `<button class="text-button" data-go="${page}">${label} ${icon('arrow')}</button>`;
const tag = text => `<span class="tag">${text}</span>`;
const state = { page:'appearance', detail:'', selected:'', tab:'', host:'Local', device:'desktop', mode:'dialogue', theme:'dark', scene:'conversation', values:{}, drafts:new Set(), tabs:{}, selectedNotes:new Set(), failNext:false, offline:false, noteEdit:null, previewStep:1, navClosed:new Set(), restored:{} };
const pageSpecs = [
 ['general','通用',0,'settings','应用偏好','preference','语言、时间与启动方式。'],
 ['appearance','外观',0,'sun','此设备','preference','让字体、留白和窗口适合你的工作习惯。'],
 ['chat','聊天',0,'chat','此设备','preference','调整阅读和交互，旁边直接看见效果。'],
 ['sessions','对话默认',0,'clock','主机与项目','mixed','新对话的模型、请求重试与会话偏好。'],
 ['notifications','通知',0,'bell','此设备','preference','在需要你关注时，以合适的方式提醒。'],
 ['voice','语音',0,'mic','按功能保存','mixed','分别配置朗读与语音输入。'],
 ['shortcuts','快捷键',0,'keyboard','此设备','preference','按动作查找、录入和调整快捷键。'],
 ['storage','存储',0,'database','资源所在设备','action','查看数据占用，按实际影响整理空间。'],
 ['history','历史与恢复',0,'clock','主机与工作区','mixed','会话保留与文件恢复历史分别管理。'],
 ['models','模型服务',1,'cloud','当前主机','document','管理服务连接和可用模型。'],
 ['agents','Agents',1,'agent','当前主机','document','保留每个 Agent 的身份、任务方式与工具选择。'],
 ['bots','Varin bot',1,'agent','当前主机','document','管理持续工作的 Bot、工作线程与记忆。'],
 ['prompt','系统提示词',1,'doc','全局 / 项目 / 会话','document','编辑自己的指令，并查看最终组合。'],
 ['memory','记忆',1,'brain','全局 / 项目 / 会话','document','查看、编辑和整理已经保存的记忆。'],
 ['tools','工具与执行',1,'terminal','当前主机','preference','按实际能力管理工具，区分可见性与授权。'],
 ['embeddings','记忆与知识嵌入',1,'database','当前主机','mixed','选择嵌入来源，管理本地模型与请求资源。'],
 ['web','网络检索和文档',1,'globe','当前主机','preference','搜索网页、读取动态页面与理解文档。'],
 ['images','图像生成与编辑',1,'image','当前主机','preference','为生成和编辑分别选择模型。'],
 ['computers','计算机使用',1,'monitor','当前主机','action','管理可用桌面与默认目标。'],
 ['permissions','权限与策略',1,'shield','主机与项目约束','document','看清哪些操作可直接执行，哪些需要询问。'],
 ['context','上下文管理',1,'layers','当前主机','preference','管理上下文预留、整理与恢复。'],
 ['projects','项目',2,'folder','所选项目','mixed','管理项目身份、目录和进入项目时的动作。'],
 ['editor','编辑器',2,'code','此设备','preference','调整代码阅读、编辑与保存行为。'],
 ['terminal','终端',2,'terminal','当前环境','preference','设置 Shell 与终端的阅读方式。'],
 ['git','Git',2,'git','账号 / 身份 / 偏好','mixed','管理提交身份、GitHub 连接与变更视图。'],
 ['retrieval','代码检索',2,'search','当前主机','preference','配置检索模型，以及可选的重排和决策能力。'],
 ['languages','语言支持',2,'code','工作区与主机','action','查看结构提取与编辑器语言服务的实际支持。'],
 ['connections','工作连接',3,'monitor','当前工作连接','action','看清 Agent、资源和桌面分别在哪里运行。'],
 ['remote','远端实例',3,'link','连接配置','document','管理 SSH 实例和直接连接的 Host。'],
 ['network','出站网络',3,'globe','当前主机','document','配置应用请求的代理与网络出口。'],
 ['access','设备与访问',3,'shield','当前主机','action','配对设备，查看和撤销访问。'],
 ['tunnel','外部隧道',3,'globe','当前主机','action','按需要开放连接，查看活动入口与会话。'],
 ['mcp','MCP',3,'plug','配置来源与主机','document','配置服务，查看连接、工具和授权状态。'],
 ['skills','Skills',3,'bolt','用户 / 项目资源','document','浏览、编辑和管理原始 SKILL.md。'],
 ['commands','Commands',3,'terminal','当前资源范围','action','查看由已启用 Skill 提供的斜杠命令。'],
 ['extensions','Varin 扩展',3,'box','当前主机','action','管理扩展、能力审阅、服务路由与工作台。'],
 ['about','关于',3,'info','此应用','action','版本、更新与开源信息。']
];
const pages = Object.fromEntries(pageSpecs.map(([id,title,group,glyph,scope,save,description]) => [id,{id,title,group,glyph,scope,save,description}]));
const groupTitles = ['使用偏好','AGENT','开发与项目','连接与扩展'];
const sourceRoot='packages/ui/src/components/sections/';
const sourceMap = {
 general:'varin/VarinSettingsPage.tsx',appearance:'varin/VarinVisualSettings.tsx',chat:'varin/ChatSettings.tsx',sessions:'varin/DefaultsSettings.tsx',notifications:'varin/NotificationSettings.tsx',voice:'varin/VoiceSettings.tsx',shortcuts:'varin/KeyboardShortcutsSettings.tsx',storage:'storage/StorageSettings.tsx',history:'varin/RecoverySettings.tsx',models:'providers/ModelConnectionsPage.tsx',agents:'agents/AgentProfileEditor.tsx',bots:'bots/BotSettings.tsx',prompt:'assistant/AgentPromptPage.tsx',memory:'assistant/AgentMemoryPage.tsx',tools:'harness/ToolsSettings.tsx',embeddings:'harness/EmbeddingSettings.tsx',web:'harness/WebSettings.tsx',images:'harness/ImageToolsSettings.tsx',computers:'computers/ComputerSettings.tsx',permissions:'harness/PermissionsSettings.tsx',context:'harness/ContextSettings.tsx',projects:'projects/ProjectSettingsPanel.tsx',editor:'varin/FileEditorPreferencesSettings.tsx',terminal:'varin/TerminalShellSettings.tsx',git:'git-identities/GitPage.tsx',retrieval:'harness/RetrievalSettings.tsx',languages:'language-support/LanguageSupportPage.tsx',connections:'connections/WorkConnectionsPage.tsx',remote:'remote-instances/RemoteInstancesPage.tsx',network:'harness/OutboundNetworkSettings.tsx',access:'remote-instances/RemoteInstancesPage.tsx',tunnel:'varin/TunnelSettings.tsx',mcp:'mcp/McpConnectionsPage.tsx',skills:'resources/NativeResourcePage.tsx',commands:'commands/CommandsPage.tsx',extensions:'extensions/ExtensionsPage.tsx',about:'varin/AboutSettings.tsx'
};
const val = (key, fallback) => state.values[valueKey(key)] ?? fallback;
const row = (title, control, desc='', id='') => `<div class="row" ${id ? 'id="'+id+'"' : ''}><div class="row-copy"><span>${title}</span>${desc ? '<p>'+desc+'</p>' : ''}</div><div class="control ${/type="checkbox"/.test(control) ? 'short' : ''}">${control}</div></div>`;
const toggle = (key, checked=true, label='', disabled=false) => `<input type="checkbox" role="switch" class="switch" data-key="${key}" aria-label="${esc(label || key)}" ${val(key,checked) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`;
const select = (key, choices, value, disabled=false) => `<select data-key="${key}" aria-label="${esc(key)}" ${disabled ? 'disabled' : ''}>${choices.map(c=>`<option ${val(key,value ?? choices[0])===c?'selected':''}>${esc(c)}</option>`).join('')}</select>`;
const input = (key, value='', type='text', extra='') => `<input type="${type}" data-key="${key}" value="${esc(val(key,value))}" aria-label="${esc(key)}" ${extra}>`;
const field = (label, key, value='', hint='', type='text') => `<div class="field"><label for="field-${key}">${label}</label>${input(key,value,type,'id="field-'+key+'"')}${hint ? '<small>'+hint+'</small>' : ''}</div>`;
const area = (key, value, cls='') => `<textarea data-key="${key}" aria-label="${esc(key)}" class="${cls}">${esc(val(key,value))}</textarea>`;
const section = (title, body, description='', action='', cls='') => `<section class="section ${cls}"><div class="section-head"><div><h2>${title}</h2>${description ? '<p>'+description+'</p>' : ''}</div>${action}</div>${body}</section>`;
const fold = (title, summary, body, open=false) => `<details class="disclosure" ${open?'open':''}><summary>${icon('arrow')}${title}<span class="sub">${summary}</span></summary><div>${body}</div></details>`;
const tabs = (items, active, group='tab') => `<div class="tabs" role="tablist">${items.map(([key,label])=>`<button role="tab" aria-selected="${key===active}" class="${key===active?'active':''}" data-tab="${key}" data-tab-group="${group}">${label}</button>`).join('')}</div>`;
const head = (title, desc='', action='') => `<header class="page-head"><div><h1>${title}</h1>${desc?'<p>'+desc+'</p>':''}</div><div class="actions">${action}</div></header>`;
const modelSelect = key => select(key,['跟随主模型','DeepSeek V4.1 Flash · DeepSeek','Claude Sonnet · Anthropic','不使用辅助模型'],'跟随主模型');
const numbered = (value, unit, key) => input(key,value,'number','class="number-field"')+'<span class="muted small">'+unit+'</span>';
const stateNote = () => state.offline ? '<div class="note warn">当前主机暂不可达。保留上次显示的内容，连接恢复后再提交更改。 '+btn('重新连接','reconnect','ghost','refresh')+'</div>' : '';
const objectRow = (name, desc, action, glyph='doc', right='') => `<div class="object-row">${icon(glyph)}<button class="object-main" data-action="${action}"><strong>${name}</strong><small>${desc}</small></button>${right || icon('arrow')}</div>`;
const options = (key, rows, selected) => `<div class="choice-list">${rows.map(([value,title,desc])=>`<button class="choice ${val(key,selected)===value?'selected':''}" data-choice="${value}" data-key="${key}"><span class="radio-dot"></span><span><strong>${title}</strong><p>${desc}</p></span></button>`).join('')}</div>`;
const renderers = {};

function miniChat(mode=state.mode) {
 const thinking = val('thinking',true) ? `<details class="disclosure" ${val('展开思考',false)?'open':''}><summary style="font-size:11px;padding:5px 0">${icon('brain')}思考 <span class="faint">先检查状态与实际保存位置…</span></summary><div style="max-height:145px;overflow:auto;font-size:11px;line-height:1.9;color:var(--muted)">计划预览只需要概括当前工作，完整内容可以继续留在计划面板。<br><br>编辑器应当替换只读内容，保留足够空间；有新版本到达时保留草稿，让用户选择如何处理。</div></details>` : '';
 const tool = '<div class="mini-tool">'+icon('doc')+' 读取 ThreadPlan.tsx</div><div class="mini-tool">'+icon('terminal')+' git diff --stat</div>'+(val('展开命令',false)?'<pre class="mini-code">ThreadPlan.tsx | 12 ++++++------\n1 file changed</pre>':'');
 const process=`<details class="disclosure"><summary style="font-size:11px;padding:5px 0">${icon('arrow')}读取文件 2 次 · 执行命令 1 次</summary><div>${thinking}${tool}</div></details>`;
 return `<div class="preview-window"><div class="preview-top"><i class="traffic"></i><i class="traffic"></i><i class="traffic"></i><span>优化计划面板</span>${icon('layers')}</div><div class="mini-chat">
 <div class="mini-user">把计划预览改得更好读一些。</div>
 ${mode==='sorted'?`<details class="disclosure"><summary>${icon('arrow')}本轮工作过程</summary><div><p>我先检查布局和保存逻辑。</p>${thinking}${tool}</div></details>`:`<p class="mini-text">我先检查布局和保存逻辑。</p>${mode==='live'?thinking+tool:process}`}
 <div class="mini-agent"><span class="avatar blue">◕</span><strong>Layout Scout</strong><span class="muted">检查窄窗布局</span></div>
 <p class="mini-text">预览聚焦当前步骤，长内容自然换行；完整计划仍可以原位编辑。</p>
 ${state.scene==='files'?'<div class="mini-code">+ overflow-wrap: anywhere;<br>+ min-width: 0;<br>+ max-height: 24rem;</div>':'<div class="mini-tool">'+icon('edit')+' ThreadPlan.tsx <span class="muted" style="margin-left:auto">已应用</span></div>'}
 <div style="display:flex;gap:12px;color:var(--muted);font-size:10px;margin-top:22px"><span>⧉　⑂　···</span><span style="margin-left:auto">↓ 12,480　↑ 436　缓存率 82.1%</span></div></div>
 <div class="mini-composer">描述你想做的事…<div class="actions"><span>＋　${icon('folder')} opencr</span><span>DeepSeek　↑</span></div></div></div>`;
}
renderers.appearance = () => head('外观','保留熟悉的工作台，让阅读尺度更合适。')+`<div class="preview-layout"><div>${
section('主题',`<div class="theme-choices">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([v,label])=>`<button class="theme-choice ${val('color-mode','dark')===v?'active':''}" data-choice="${v}" data-key="color-mode"><div class="theme-sample ${v==='light'?'':'dark'}"><div class="lines"><i></i><i></i><i></i></div></div>${label}</button>`).join('')}</div>`+row('深色主题',select('深色主题',['当前深色主题','选择已安装主题…']))+row('浅色主题',select('浅色主题',['当前浅色主题','选择已安装主题…'])))+
section('阅读尺度',row('界面字号',numbered('14','px','界面字号'))+row('正文与代码',route('分别调整聊天与编辑器','chat'),'正文、代码和终端保留各自的字号。')+row('内容留白',select('内容留白',['紧凑','标准','舒展'],'标准'))+row('圆角',numbered('8','px','圆角')))+
section('窗口',row('窗口控制按钮',select('窗口控制按钮',['跟随系统','左侧','右侧']))+row('透明背景',toggle('透明背景',false),'仅在支持此效果的桌面环境显示。')+fold('移动端输入区', '沿设备显示',row('输入框底部偏移',numbered('0','px','输入框底部偏移'))))
}</div><aside class="preview"><div class="preview-label"><span>工作台预览</span><span>跟随当前选择</span></div><div id="live-preview">${miniChat()}</div><p class="preview-footer">主题、字号和留白跟随左侧选择。</p></aside></div>`;
renderers.chat = () => head('聊天','呈现方式各有侧重，内容与执行事实保持相同。')+`<div class="preview-layout"><div>${
 section('回答与过程', options('chat-mode', [['dialogue','对话优先','正文连续阅读，普通过程收成一行。'],['live','按时间展开','按发生顺序查看正文、思考与工具。'],['sorted','集中展示回答','本轮过程集中收起，回答保留在外层。']],state.mode))+
 section('思考与工具',row('显示思考内容',toggle('thinking',true))+ (val('thinking',true)?row('自动展开思考',toggle('展开思考',false),'长内容在独立阅读窗口中滚动。'):'')+row('自动展开命令',toggle('展开命令',false))+row('自动展开编辑',toggle('展开编辑',true)))+
 section('阅读',row('聊天宽度',select('聊天宽度',['跟随窗口','适中','宽'],'适中'))+row('用户消息',select('用户消息',['普通文本','Markdown']))+row('折叠长消息',toggle('折叠长消息'))+row('固定本轮问题',toggle('固定本轮问题'))+row('对话导航',toggle('对话导航')))+
 fold('输入与草稿','执行中发送、草稿保留',row('执行中发送',select('执行中发送',['排队','作为补充']))+row('保留未发送草稿',toggle('保留未发送草稿'))+row('拼写检查',toggle('拼写检查',false))+row('新会话起始入口',toggle('新会话起始入口')))+
 fold('文件与代码','换行、差异与预览',row('代码自动换行',toggle('代码自动换行'))+row('差异布局',select('差异布局',['统一','并排']))+row('Mermaid',select('Mermaid',['渲染图表','源代码']))+row('文件图标',toggle('文件图标'))+row('回合文件变更',toggle('回合文件变更'))+row('打开文件时预览',toggle('打开文件时预览'))+row('显示隐藏文件',toggle('显示隐藏文件',false)))
}</div><aside class="preview"><div class="preview-label"><span>实际内容预览</span><div class="segmented"><button class="${state.scene==='conversation'?'active':''}" data-scene="conversation">对话</button><button class="${state.scene==='files'?'active':''}" data-scene="files">文件</button></div></div><div id="live-preview">${miniChat()}</div><p class="preview-footer">使用同一段内容对比三种阅读方式。</p></aside></div>`;

renderers.models = () => {
 if(state.detail==='add') return head('添加模型服务','选择服务类型，再填写连接与模型。')+`<div class="provider-pick">${[['deepseek','DeepSeek','API Key'],['anthropic','Anthropic','API Key / 支持的账号授权'],['openai','OpenAI','API Key'],['ollama','Ollama','本地地址'],['google','Google','API Key / 受支持认证'],['openrouter','OpenRouter','API Key']].map(([id,name,auth])=>`<button data-action="service:${id}">${logo(id)}<span><strong>${name}</strong><small>${auth}</small></span>${icon('arrow')}</button>`).join('')}</div>`;
 if(state.detail==='model') return modelEditor();
 if(state.detail==='service') return serviceEditor();
 return head('模型服务','连接模型服务，为不同任务选择合适的模型。',btn('添加服务','model-add','primary','plus'))+
 `<div class="list-toolbar"><span style="margin:0">已配置服务 · 3</span><span></span>${input('筛选服务','','search','placeholder="筛选服务" data-list-filter')}</div><div class="object-list">${[
 ['deepseek','DeepSeek','api.deepseek.com','2 个模型'],['anthropic','Anthropic','api.anthropic.com','3 个模型'],['ollama','本地 Ollama','127.0.0.1:11434','1 个模型']
 ].map(([id,name,url,count])=>`<div class="object-row" data-filter-text="${name} ${url}">${logo(id)}<button class="object-main" data-action="service:${id}"><strong>${name}</strong><small>${url}</small></button><span class="count">${count}</span>${toggle('启用 '+name,true,name)}<button class="icon-button" data-action="service:${id}" aria-label="管理 ${name}">${icon('arrow')}</button></div>`).join('')}</div>
 <div class="hint" style="display:flex;align-items:center;gap:10px;margin-top:22px">模型目录按现有机制刷新。${btn('刷新目录','catalog-refresh','ghost','refresh')}</div>
 ${section('为不同任务选择模型',objectRow('默认对话模型','用于新对话；项目可以覆盖默认值。','goto:sessions','chat')+objectRow('Agent 与辅助任务','各自保留模型与继承方式。','goto:agents','agent'),'选择使用位置时，仍引用同一个服务目录。')}`;
};
const sampleServices = {
 deepseek:{name:'DeepSeek',url:'https://api.deepseek.com',models:['DeepSeek V4.1 Flash','DeepSeek Reasoner'],ids:['deepseek-flash','deepseek-reasoner'],protocol:'OpenAI Chat Completions'},
 anthropic:{name:'Anthropic',url:'https://api.anthropic.com',models:['Claude Sonnet','Claude Opus','Claude Haiku'],ids:['example-sonnet','example-opus','example-haiku'],protocol:'Anthropic Messages'},
 ollama:{name:'本地 Ollama',url:'http://127.0.0.1:11434',models:['本地对话模型'],ids:['local-chat'],protocol:'OpenAI Chat Completions'},
 openai:{name:'OpenAI',url:'https://api.openai.com/v1',models:['自定义对话模型'],ids:['example-chat'],protocol:'OpenAI Responses'}
};
const serviceData = () => sampleServices[state.selected] || {name:state.selected,url:'https://api.example.test/v1',models:['自定义模型'],ids:['example-model'],protocol:'OpenAI Chat Completions'};
const serviceModels = () => draftValues[owner()+'|服务模型'] || serviceData().models;
function editServiceModels(models){
 if(!(owner() in state.restored))state.restored[owner()]={...draftValues};
 draftValues[owner()+'|服务模型']=models;state.drafts.add(owner());render();
}
function serviceEditor(){
 const id=state.selected||'deepseek', name=serviceData().name;
 const tab=state.tabs.service||'models';
 return `<div class="object-heading">${logo(id)}<div><h1>${name}</h1><small>模型服务</small></div><div class="actions">${toggle('服务启用',true,'启用服务')}</div></div>`+
 tabs([['models','模型'],['connection','连接与认证'],['advanced','请求配置']],tab,'service')+
 (tab==='models'?`<div class="list-toolbar">${input('筛选模型','','search','placeholder="筛选模型" data-list-filter')}<span>模型变更随服务一起保存</span></div><div class="object-list">${serviceModels().map((m,i)=>`<div class="object-row" data-filter-text="${m}">${logo(id)}<button class="object-main" data-action="model:${m}"><strong>${m}</strong><small>${i?'对话 · 思考':'对话 · 图片输入'}　·　跟随目录</small></button>${toggle('启用模型'+i,true,m)}<button class="icon-button" data-action="model:${m}" aria-label="编辑 ${m}">${icon('arrow')}</button></div>`).join('')}</div><div class="actions" style="margin-top:18px">${btn('从目录添加','model-catalog','','plus')}${btn('输入模型 ID','model-manual','ghost')}</div>`:
 tab==='connection'?section('连接',field('服务名称','服务名称',name)+field('服务地址','服务地址',serviceData().url,'请求路径在“请求配置”中管理。','url'))+
 section('认证',row('认证方式',select('认证方式',['API Key','环境变量','无认证'],'API Key'))+`<div class="resource-line">${icon('key')}<div><p>凭据已配置</p><small>更换时输入新凭据，已有密钥不回显。</small></div>${btn('更换','credential','ghost')}</div>`):
 section('网络与请求路径',field('代理','服务代理','','留空使用当前主机的出站网络设置。')+field('请求头','请求头','{}')+fold('接口路径','按用途分别配置',field('对话路径','对话路径','/chat/completions')+field('嵌入路径','嵌入路径','/embeddings')+field('重排路径','重排路径','/rerank')))+
 section('服务参数',area('服务参数','{\n  \n}','reading-editor code'),'保留 JSON 参数编辑入口。')+section('移除服务',btn('移除此服务','remove-service','danger'),'移除配置前展示受影响的模型。'));
}
function modelEditor(){
 const name=state.modelName||serviceModels()[0]||'新模型';
 return head(name,'模型配置保存在所属服务内。')+`<div class="model-editor-layout"><div>${
 section('基本信息',field('显示名称','模型显示名称',name)+field('实际模型 ID 或部署名','实际模型ID',serviceData().ids[serviceData().models.indexOf(name)]||name)+`<div class="actions" style="gap:18px;margin:20px 0">${['对话','嵌入','重排','快速决策','图像生成','图像编辑'].map((l,i)=>`<label class="small"><input type="checkbox" data-key="用途-${l}" ${val('用途-'+l,i===0)?'checked':''}> ${l}</label>`).join('')}</div>`)+
 section('模型能力',row('图片输入',toggle('图片输入'))+row('支持思考',toggle('支持思考'))+`<div class="field-pair">${field('上下文容量 · token','上下文容量','128000','','number')}${field('最大输出 · token','最大输出','8192','','number')}</div>`+
 '<p class="hint">字段可跟随模型目录；自行修改后保留覆盖标记。 '+btn('恢复目录值','restore-model','ghost')+'</p>')+
 (val('用途-快速决策',false)?section('快速决策',row('接口预设',select('决策预设',['System One','Cloudflare Workers AI System One','llama.cpp']))+
 (val('决策预设','System One')==='llama.cpp'?field('分词路径','决策分词路径','/tokenize')+field('模板路径','决策模板路径','/apply-template')+field('补全路径','决策补全路径','/completion'):
 field('决策路径','决策路径',val('决策预设','System One')==='Cloudflare Workers AI System One'?'/run':'/systemone'))+
 '<p class="hint">路径追加到服务地址。清空覆盖后使用继承值；切换预设时填入对应路径。</p>'):'')+
 ((val('用途-图像生成',false)||val('用途-图像编辑',false))?section('图像接口',row('接口预设',select('图像预设',['OpenAI Images','OpenRouter Images']))+
 (val('用途-图像生成',false)?field('生成路径','图像生成路径',val('图像预设','OpenAI Images')==='OpenRouter Images'?'/chat/completions':'/images/generations'):'')+
 (val('用途-图像编辑',false)?field('编辑路径','图像编辑路径',val('图像预设','OpenAI Images')==='OpenRouter Images'?'/chat/completions':'/images/edits'):'')
 ):'')+
 fold('协议与思考参数','按模型协议显示',row('协议',select('协议',['OpenAI Chat Completions','OpenAI Responses','Anthropic Messages'],serviceData().protocol))+row('思考方式',select('思考方式',['按等级选择','Token 预算','沿协议默认']))+field('思考格式','思考格式',''))+
 fold('Tokenizer','保持已有配置入口',row('来源',select('Tokenizer来源',['自动选择','指定 tokenizer']))+field('Tokenizer 标识','Tokenizer标识',''))+
 fold('原始参数','parameters / compat',area('模型参数','{\n  "parameters": {},\n  "compat": {}\n}','reading-editor code'))+
 '<div style="margin-top:24px">'+btn('移除模型','remove-model','danger ghost')+'</div>'
}</div><aside class="insight"><h3>在对话中显示</h3><div class="mini-composer">输入消息…<div class="actions"><span>＋</span><span data-model-preview="name">${esc(name)}</span><span>↑</span></div></div><p data-model-preview="capabilities">对话 · 图片输入 · 支持思考</p><p style="margin-top:12px">上下文 <span data-model-preview="context">128,000</span> token<br>最大输出 <span data-model-preview="output">8,192</span> token</p>${btn('测试此模型','test-model','','bolt')}<p class="hint">使用当前草稿进行一次简短请求。测试结果显示在这里。</p><div id="test-result"></div></aside></div>`;
}

renderers.web = () => head('网络检索和文档','配置网页搜索、文档阅读与访问范围。')+
 `<div class="page-nav"><button data-anchor="web-search">网页搜索</button><button data-anchor="web-reading">文档阅读</button><button data-anchor="web-access">访问范围</button></div>`+
 `<div id="web-search">${section('网页搜索',row('允许搜索网页',toggle('网页搜索'))+row('搜索提供商',select('搜索提供商',['默认搜索 · 无需密钥','Brave','Exa','Tavily','Jina','SearXNG']))+
 (val('搜索提供商','默认搜索 · 无需密钥')==='默认搜索 · 无需密钥'?'<p class="hint">搜索词发送给 Exa；不可用时使用 Parallel。服务可能有使用限制。</p>':field(val('搜索提供商','')==='SearXNG'?'服务地址':'API Key','搜索凭据','','凭据由当前主机保存。',val('搜索提供商','')==='SearXNG'?'url':'password'))+
 row('渲染动态网页',toggle('渲染动态网页',false,state.host==='Local'?'渲染动态网页':'当前主机不支持',state.host!=='Local'),'由桌面本地主机渲染需要执行脚本的页面。'))}</div>`+
 `<div id="web-reading">${section('文档阅读',`<p class="hint" style="margin:0 0 18px">默认支持基础文本和页面图像读取；复杂材料可以搭配模型辅助或本地解析组件。</p>`+
 row('辅助阅读',select('辅助阅读',['不使用辅助模型','DeepSeek V4.1 Flash · DeepSeek','Claude Sonnet · Anthropic'],'不使用辅助模型'),'用于整理和理解读取到的材料。')+
 fold('扫描件与复杂排版','OCR 与结构解析',field('OCR 语言','OCR语言','eng','可填写已安装的 Tesseract 语言，如 eng、chi_sim。')+
 field('Tesseract 可执行文件','Tesseract路径','tesseract','填写可直接启动的文件名或路径。')+field('Docling 可执行文件','Docling路径','docling')+
 '<p class="hint">填写本机已安装组件的可执行文件名或完整路径。</p>'))}</div>`+
 `<div id="web-access">${section('访问范围',row('仅访问指定域名',toggle('域名白名单',false),'开启后，空列表表示尚未允许任何域名。')+(val('域名白名单',false)?field('允许域名','允许域名','docs.example.com'):'')+fold('阻止的域名','未设置',area('阻止域名','ads.example.com')))}</div>`;

renderers.sessions = () => {
 const project=val('范围','主机默认')==='项目 · opencr';
 return head('对话默认','默认值用于后续对话，运行中的请求保留原配置。')+
 `<div class="actions" style="margin-bottom:24px">${select('范围',['主机默认','项目 · opencr'],'主机默认')}<span class="small muted">${project?'当前项目已信任':'保存在 '+state.host}</span></div>`+
 section('新对话',row('默认模型',project?select('默认模型',['继承主机 · DeepSeek V4.1 Flash','Claude Sonnet · Anthropic']):modelSelect('默认模型'))+row('思考等级',select('默认思考',['跟随模型','低','中','高'],'高'))+
 (project?'<p class="hint">未覆盖的字段继续使用主机默认值。 '+btn('恢复继承','inherit-defaults','ghost')+'</p>':row('辅助模型',select('辅助模型',['未指定','DeepSeek V4.1 Flash · DeepSeek']),'用于会话标题等辅助工作。')))+
 (project?'<div class="note">请求重试在主机默认中管理。 '+btn('查看主机默认','global-scope','ghost')+'</div>':retrySection())+
 section('此设备的偏好',row('删除会话前确认',toggle('删除确认')),'与上述模型设置分别保存。');
};
function retrySection(){
 return section('请求重试',row('自动重试',toggle('自动重试'))+
 `<div class="field-pair">${field('最多重试次数','重试次数','3','','number')}${field('首次等待 · 毫秒','首次等待','1000','','number')}</div>`+
 row('最长等待',numbered('30000','ms','最长等待'))+
 fold('自定义匹配规则','按顺序匹配 · 2 条',`<table class="table"><thead><tr><th style="width:27%">匹配字段</th><th>条件</th><th style="width:20%">动作</th><th style="width:44px"></th></tr></thead><tbody id="retry-rules"><tr><td>状态码</td><td><code>精确 · 503</code></td><td>重试</td><td><button data-action="edit-retry" class="icon-button" aria-label="编辑重试规则">${icon('edit')}</button></td></tr><tr><td>错误消息</td><td><code>包含 · temporarily unavailable</code></td><td>重试</td><td><button data-action="edit-retry" class="icon-button" aria-label="编辑重试规则">${icon('edit')}</button></td></tr></tbody></table><div class="actions" style="margin-top:14px">${btn('添加规则','edit-retry','ghost','plus')}${btn('用错误样例检查','retry-sample','ghost')}</div>`)+
 '<div class="actions" style="margin-top:18px"><span class="small muted" style="flex:1">这一组单独保存</span>'+btn('保存重试设置','save-section:retry')+'</div>',
 '短暂服务波动由现有重试策略处理。规则可以补充常见错误匹配。');
}

renderers.storage = () => {
 const cats=[['恢复与工作状态','8.4 GiB',34,'#9bbca7'],['独立工作副本','6.2 GiB',25,'#9caec4'],['会话与附件','4.6 GiB',19,'#c2ac8e'],['记忆与知识向量','1.8 GiB',7,'#b3a1bb'],['共享模型资源','2.9 GiB',12,'#8baeb1'],['其他应用数据','0.7 GiB',3,'#8e918b']];
 return head('存储','每一类数据有自己的用途与回收条件。',btn('刷新','storage-refresh','ghost','refresh'))+
 `<div class="actions" style="margin-bottom:28px">${select('存储设备',['Local · 此电脑','Workspace Host · 远端'])}${select('存储范围',['全部数据','项目 · opencr','共享资源'])}</div><div class="storage-total"><strong>24.6</strong><span>GiB · 已统计占用</span></div><div class="storage-bar">${cats.map(c=>`<span style="width:${c[2]}%;background:${c[3]}"></span>`).join('')}</div><div class="storage-legend">${cats.map(c=>`<div><i style="background:${c[3]}"></i>${c[0]}<strong>${c[1]}</strong></div>`).join('')}</div>`+
 section('整理空间',objectRow('检查可回收内容','先列出对象、占用情况和预计影响，再选择清理。','cleanup-preview','database',btn('查看清理预览','cleanup-preview','','search'))+
 objectRow('独立工作副本','保留正在使用和仍被引用的副本，沿各自生命周期回收。','copy-info','folder')+objectRow('会话与文件恢复历史','保留期限和恢复位置在历史与恢复中管理。','goto:history','clock'))+
 section('项目占用',`<table class="table"><thead><tr><th>项目</th><th style="width:24%">占用</th><th style="width:30%">范围</th></tr></thead><tbody><tr><td><button class="text-button" data-action="storage-project">opencr</button></td><td>13.8 GiB</td><td>项目数据</td></tr><tr><td>Design Lab</td><td>4.1 GiB</td><td>项目数据</td></tr><tr><td>共享资源</td><td>6.7 GiB</td><td>多个项目引用</td></tr></tbody></table>`);
};

const permissionRules=()=>val('权限规则',[
 {tool:'mcp__docs__search',decision:'允许',param:'',pattern:''},
 {tool:'example_publish',decision:'询问',param:'',pattern:''}
]);
renderers.permissions = () => head('权限与策略','决定哪些操作直接执行，哪些需要向你确认。')+
 section('默认行为',options('权限模式',[['normal','普通','没有明确允许的操作需要询问。'],['accept-edits','接受编辑','允许常规编辑，其他操作继续按规则确认。'],['smart','智能判断','使用已经配置的权限判断模型。'],['bypass','直接允许','跳过操作确认；文件和进程仍受资源访问范围约束。']],'normal')+(val('权限模式','normal')==='smart'?row('判断模型',modelSelect('权限判断模型')):''))+
 section('用户规则',`<table class="table"><thead><tr><th style="width:36%">工具</th><th>参数范围</th><th style="width:15%">决定</th><th style="width:112px"></th></tr></thead><tbody>${permissionRules().map((rule,i)=>`<tr><td><button class="text-button" data-action="permission-edit:${i}"><code>${esc(rule.tool)}</code></button></td><td>${rule.param?'<code>'+esc(rule.param)+' · '+esc(rule.pattern)+'</code>':'全部参数'}</td><td><span class="status ${rule.decision==='允许'?'ok':rule.decision==='拒绝'?'bad':'warn'}">${rule.decision}</span></td><td><div class="actions"><button class="icon-button" data-action="permission-up:${i}" aria-label="上移规则" ${i===0?'disabled':''}>↑</button><button class="icon-button" data-action="permission-down:${i}" aria-label="下移规则" ${i===permissionRules().length-1?'disabled':''}>↓</button><button class="icon-button" data-action="permission-delete:${i}" aria-label="移除规则">${icon('trash')}</button></div></td></tr>`).join('')}</tbody></table><div class="actions" style="margin-top:15px">${btn('添加规则','edit-permission','ghost','plus')}</div>`,
 '从上到下匹配。聊天中的“一直允许”保存到这份规则中。')+
 section('项目约束',objectRow('opencr','继承主机规则；项目的询问与拒绝约束优先。','permission-project','folder'))+
 '<div class="note">文件和进程还受工作来源和可访问资源范围约束。工具规则只决定操作是否需要确认。</div>';

renderers.tools = () => head('工具与执行','查看可用能力，调整 Agent 的工具选择与执行方式。')+
 section('工具目录',`<div class="list-toolbar">${input('搜索工具','','search','placeholder="搜索工具或能力" data-list-filter')}<span>已注册工具</span></div>`+
 [['文件与代码','file_read · file_search · file_write · file_edit','code'],['终端与进程','process_spawn · process_read · process_write','terminal'],['网页与文档','websearch · webfetch · document_read','globe'],['扩展与 MCP','来自已启用的扩展和 MCP 服务','plug']].map(([n,d,i])=>objectRow(n,d,'tool-family:'+n,i)).join(''),
 '目录标明来源与使用方式；选择能力查看具体工具。')+
 section('使用方式',objectRow('按 Agent 选择工具','在 Agent 配置中指定可以使用的注册工具。','goto:agents','agent')+objectRow('权限与策略','管理允许、询问和拒绝规则。','goto:permissions','shield')+objectRow('Shell 与输出','配置默认 Shell、等待方式和输出显示。','execution-options','terminal'))+
 '<p class="hint">工具可用时，仍会按权限规则判断是否需要确认。</p>';

const noteItems={
 '全局':[{id:1,text:'偏好直接、自然的中文说明。涉及设计时，先解释具体交互和取舍。',source:'手动记录'},{id:2,text:'工具展示应根据实际用途设计。保留子 Agent 的身份与头像。',source:'来自会话'}],
 '项目 · opencr':[{id:3,text:'工作概览占据布局空间；完整计划在面板内原位编辑。',source:'来自会话'}],
 '会话 · 计划面板优化':[{id:4,text:'编辑过程中保留草稿；Agent 更新计划时显示查看新版的入口。',source:'来自当前会话'}]
};
let nextNoteId=5;
const currentNotes=()=>noteItems[val('记忆范围','全局')];
renderers.memory = () => head('记忆','记录偏好与已经确认的信息，后续工作可以继续沿用。',btn('添加记忆','memory-add','primary','plus'))+
 `<div class="actions" style="margin-bottom:22px">${select('记忆范围',['全局','项目 · opencr','会话 · 计划面板优化'])}<span class="small muted">保存在当前主机</span></div><div class="list-toolbar">${input('搜索记忆','','search','placeholder="搜索记忆内容" data-list-filter')}<span>${currentNotes().length} 条记忆</span></div>`+
 (currentNotes().length?currentNotes().map(({id,text,source})=>`<article class="note-article" data-filter-text="${esc(val('记忆正文-'+id,text))}">${state.noteEdit===id?area('记忆正文-'+id,text):'<p>'+esc(val('记忆正文-'+id,text))+'</p>'}<div class="note-actions"><button class="icon-button" data-action="memory-edit:${id}" aria-label="编辑记忆">${icon('edit')}</button><button class="icon-button" data-action="memory-delete:${id}" aria-label="删除记忆">${icon('trash')}</button></div><small>${source}</small>${state.noteEdit===id?'<div class="actions" style="margin-top:13px">'+btn('保存这条记忆','memory-save','primary')+btn('取消','memory-cancel','ghost')+'</div>':''}</article>`).join(''):'<div class="empty">'+icon('brain')+'<h2>这里还没有记忆</h2><p>添加需要长期保留的偏好、约定或项目背景。</p></div>')+
 '<div style="margin-top:25px">'+route('配置记忆与知识嵌入','embeddings')+'</div>';

renderers.prompt = () => head('系统提示词','编辑自定义指令，系统组合与工具声明保持可追溯。')+
 `<div class="actions" style="margin-bottom:24px">${select('提示词范围',['全局','项目 · opencr','会话 · 计划面板优化'])}</div>`+
 tabs([['edit','自定义指令'],['assembled','组合预览'],['tools','工具声明']],state.tabs.prompt||'edit','prompt')+
 ((state.tabs.prompt||'edit')==='edit'?
 section('表达与协作',row('说明密度',select('说明密度',['沿默认','简洁','均衡','详细']))+row('表达风格',select('表达风格',['沿默认','直接自然','日常交流','专业精确']))+row('自主推进',select('自主推进',['沿默认','先讨论','自主完成已授权任务'])))+
 section('自定义内容',area('自定义指令','使用自然、直接的中文。\n\n解释影响判断的事实和取舍。完成工作时说明关键变化与剩余问题。','reading-editor'),'文字在原位置编辑；保存前可以切换到组合预览。'):
 (state.tabs.prompt==='tools'?section('工具声明',fold('file_read','schema 与说明',`<pre>${esc('Read an admitted file or complete code unit.\\n\\n{ "path": "…", "startLine": 1 }')}</pre>`)+fold('ask_user','多题与结构化答案','<p class="hint">声明由实际工具目录提供，预览只读。</p>')):
 section('最终组合',`<div class="split"><div class="subnav"><button class="active">运行时身份 <small>系统生成 · 只读</small></button><button>自定义指令 <small>全局</small></button><button>项目说明 <small>opencr</small></button><button>记忆 <small>按原始范围组合</small></button></div><div><p class="small-label">只读预览 · 示例</p><pre class="reading-editor code">${esc('runtime_identity\\n…\\n\\nuser_instructions\\n使用自然、直接的中文。\\n\\nproject_context\\nopencr')}</pre></div></div>`)));

renderers.agents = () => {
 const name=state.selected||'执行 Agent';
 return head('Agents','为不同工作安排模型、指令与工具。',btn('新建 Agent','agent-add','','plus'))+
 `<div class="split"><aside class="subnav">${['执行 Agent','探索 Agent','验证 Agent','上下文整理'].map((n,i)=>`<button class="${n===name?'active':''}" data-action="agent-select:${n}"><span class="avatar ${i%2?'blue':'warm'}" style="display:inline-flex;width:22px;height:22px;font-size:14px;margin-right:6px">${['◕','◡','◔','◒'][i]}</span>${n}<small>${i===3?'内置自动任务':'内置配置 · 可覆盖'}</small></button>`).join('')}</aside><div><div class="object-heading"><span class="avatar blue">◕</span><div><h2>${name}</h2><small class="muted">设置 Agent 的头像与名称</small></div><div class="actions">${btn('更换头像','avatar','ghost')}${toggle('启用 Agent')}</div></div>${
 field('名称','Agent名称',name)+field('用途说明','Agent用途','承担边界明确的工作，并汇报结果。')+
 section('模型与指令',row('模型',modelSelect('Agent模型'))+row('思考等级',select('Agent思考',['继承','低','中','高']))+
 fold('生成参数','温度与协议默认',field('温度','Agent温度','','留空沿模型默认。','number'))+
 area('Agent指令','完成分配的任务，保留原始证据与来源。\n遇到影响任务结果的未知时，说明缺失信息。','reading-editor'))+
 section('工具与工作方式',row('工具选择',btn('选择注册工具','agent-tools'),'可以继承默认工具，也可以指定可用工具。')+
 '<div class="tags">'+['file_read','file_search','process_spawn'].map(tag).join('')+'</div>'+
 row('工作来源',select('Agent来源',['共享当前来源','只读来源','独立工作副本'],'独立工作副本'))+
 '<p class="hint">独立工作副本中的更改可以在任务完成后审阅。</p>')
 }</div></div>`;
};

renderers.bots = () => { return head('Varin bot','配置与正在进行的工作分开查看。',btn('新建 Bot','bot-add','','plus'))+
 `<div class="split"><aside class="subnav"><button class="active" data-action="bot-select:项目助手"><span class="avatar warm" style="display:inline-flex;width:22px;height:22px;font-size:14px;margin-right:7px">◒</span>项目助手<small>3 个工作线程</small></button><button data-action="bot-select:文档助手">文档助手<small>已暂停</small></button></aside><div>${
 tabs([['profile','配置'],['work','工作线程'],['memory','记忆偏好']],state.tabs.bot||'profile','bot')+
 ((state.tabs.bot||'profile')==='profile'?field('名称','Bot名称',state.selected||'项目助手')+field('说明','Bot说明','围绕项目持续处理安排的工作。')+section('指令',area('Bot指令','遵循项目说明。保持工作记录可追溯。','reading-editor'))+row('模型',modelSelect('Bot模型'),'修改后用于后续模型请求。'):
 state.tabs.bot==='work'?objectRow('检查项目文档','等待后续任务 · 示例状态','bot-work','doc',tag('等待'))+objectRow('整理已发现问题','本轮已完成 · 示例状态','bot-work','chat',tag('已完成'))+btn('查看工作线程','bot-work','ghost'):
 section('记忆整理',row('整理模型',modelSelect('Bot记忆模型'))+route('查看保存的记忆','memory')))
 }</div></div>`;
};

renderers.embeddings = () => {
 const local=val('嵌入来源','本地模型')==='本地模型';
 return head('记忆与知识嵌入','为记忆与知识选择模型，管理下载和资源使用。')+
 section('嵌入来源',options('嵌入来源',[['本地模型','本地模型','使用本机模型进行记忆与知识嵌入。'],['模型服务','模型服务','使用已配置服务中的嵌入模型。'],['默认','沿默认配置','使用当前主机的默认嵌入配置。']],'本地模型'))+
 (local?section('本地模型',`<div class="resource-line">${icon('database')}<div><p>当前本地嵌入模型</p><small>可在下方查看模型文件、下载进度与占用。</small></div><span class="status">已下载 · 示例</span></div><div class="actions" style="margin-top:14px">${btn('管理模型文件','local-models')}${btn('刷新状态','local-refresh','ghost','refresh')}</div>`):
 section('服务与模型',row('模型服务',select('嵌入服务',['选择服务','OpenAI','本地 Ollama']))+field('嵌入模型 ID','嵌入模型','text-embedding-3-small')))+
 section('请求资源',row('并发请求',numbered('2','个','嵌入并发'))+row('请求间隔',numbered('200','ms','嵌入间隔'))+fold('本地 CPU','自动',row('资源偏好',select('CPU偏好',['自动','节能','性能']))+field('线程数','CPU线程','','留空使用自动配置。','number'))+
 '<div class="actions" style="margin-top:18px"><span class="small muted" style="flex:1">保存后重启 Host 生效</span>'+btn('保存请求设置','save-section:embedding')+'</div>');
};

renderers.images = () => head('图像生成与编辑','分别指定模型，保留模型标识与用途。')+
 section('生成图像',row('生成模型',select('生成模型',['未选择','已配置的图像生成模型']),'从支持图像生成的模型目录中选择。')+
 '<div class="note">选择模型后，聊天中的图像工具沿该配置工作。</div>')+
 section('编辑图像',row('编辑模型',select('编辑模型',['未选择','已配置的图像编辑模型']),'生成与编辑可以使用不同的模型。'))+
 route('管理模型服务','models');

const percentText=n=>Number(n.toFixed(2)).toString();
let contextDrag=null;
function contextBoundaries(){
 const replace=state.contextPreview?.replace??100-Number(val('上下文预留',10));
 const waterline=state.contextPreview?.waterline??Number(val('压缩准备水位',0.75));
 return {replace,waterline,prepare:replace*waterline,enabled:val('后台准备',true)};
}
function contextScale(){
 const {replace,prepare,waterline,enabled}=contextBoundaries();
 return `<div class="context-scale ${enabled?'':'preparation-off'}" id="context-scale" style="--prepare:${prepare}%;--replace:${replace}%">
 <div class="context-axis"><span>0%</span><span>模型上下文窗口 · 100%</span></div>
 <div class="context-track"><div class="context-ordinary"></div><div class="context-preparing"></div><div class="context-reserved"></div>
 <button class="context-marker preparation-marker" data-context-drag="prepare" role="slider" aria-label="准备水位，按可用输入预算计算" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${waterline*100}" aria-valuetext="准备水位 ${percentText(waterline*100)}%，对应全窗口 ${percentText(prepare)}%" ${enabled?'':'disabled'}></button>
 <span class="context-position preparation-label" data-context-label="prepare">准备基准 · ${percentText(prepare)}%</span>
 <button class="context-marker replacement-marker" data-context-drag="replace" role="slider" aria-label="替换边界，按整个模型窗口计算" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${replace}" aria-valuetext="全窗口 ${percentText(replace)}%，预留 ${percentText(100-replace)}%"></button>
 <span class="context-position replacement-label" data-context-label="replace">替换 · ${percentText(replace)}%</span></div>
 <div class="context-legend"><span><i class="ordinary"></i>继续使用当前上下文</span><span data-context-preparation><i class="preparing"></i>后台准备摘要</span><span><i class="reserved"></i>预留空间 <b data-context-reserve>${percentText(100-replace)}%</b></span></div>
 </div>
 <div class="context-boundaries">
 <div class="context-boundary"><label for="context-prepare"><span class="context-dot preparing"></span>准备水位</label><div class="actions"><input id="context-prepare" data-context-threshold="prepare" class="number-field" type="number" step="any" value="${Number((waterline*100).toPrecision(12))}" ${enabled?'':'disabled'}><span class="small muted">% · 可用输入预算</span></div><p><span data-context-prepare-note>对应整个窗口的 ${percentText(prepare)}%（基准）。</span>提前准备摘要，对话继续进行；运行时可能根据增长速度和压缩耗时提前。</p></div>
 <div class="context-boundary"><label for="context-replace"><span class="context-dot reserved"></span>替换上下文</label><div class="actions"><input id="context-replace" data-context-threshold="replace" class="number-field" type="number" step="any" value="${percentText(replace)}"><span class="small muted">%</span></div><p>输入用量超过此位置时切换压缩结果；尚未就绪则等待。<span data-context-reserve-note>对应预留 ${percentText(100-replace)}%。</span></p></div>
 </div><p id="context-boundary-error" class="error-inline" role="alert"></p>
 <p class="hint">拖动标记调整时机，也可在下方精确输入。准备水位按可用输入预算计算；比例条与替换位置按整个窗口显示。</p>`;
}
renderers.context = () => head('上下文管理','让长对话保持连续，提前压缩，在需要时替换。')+
 section('压缩与替换',row('后台压缩准备',toggle('后台准备'),'开启后，提前准备摘要，减少切换时的等待。')+
 contextScale()+
 fold('比例如何计算','可用输入预算与预留',`<p class="hint">替换位置 = 100% − 预留比例。后台压缩的基准位置 = 替换位置 × 准备水位。当前准备水位为可用输入预算的 <span data-context-waterline>${percentText(Number(val('压缩准备水位',0.75))*100)}%</span>。</p><p class="hint">调整替换位置时，准备水位保持不变，后台压缩标记会按比例移动。关闭后台准备仍会在需要替换时进行压缩。</p>`))+
 section('整理与辅助',objectRow('上下文整理 Agent','在 Agent 配置中管理其模型、指令和行为。','goto:agents','layers')+row('计划辅助模型',modelSelect('计划辅助模型'))+row('下一步辅助',toggle('下一步辅助',false))+
 (val('下一步辅助',false)?row('下一步模型',modelSelect('下一步模型')):''))+
 fold('整理失败后的恢复','恢复开关与等待条件',row('自动恢复',toggle('整理恢复'))+row('流式空闲等待',numbered('60','s','整理空闲'))+row('响应等待',numbered('120','s','整理响应'))+row('重试次数',numbered('2','次','整理重试')))+
 fold('消息时间','沿现有策略',row('附加消息时间',toggle('附加消息时间',true)));

renderers.retrieval = () => head('代码检索','检索入口保持轻量，可选能力分别解释。')+
 section('快速检索',row('检索模型',modelSelect('检索模型'),'跟随主模型，或选择适合探索任务的普通对话模型。'))+
 section('可选能力',fold('重排','沿默认或单独配置',row('来源',select('重排来源',['默认','模型服务']))+row('服务',select('重排服务',['选择服务']))+field('模型 ID','重排模型','rerank-v3.5')+field('接口路径','重排路径','/rerank'))+
 fold('快速决策','未单独配置',row('来源',select('决策来源',['默认','模型服务']))+row('服务',select('决策服务',['选择服务']))+field('模型 ID','决策模型','')+field('接口路径','决策路径','')+
 row('用途',select('决策用途',['按现有用途配置','禁用']))),'保留现有配置，不把使用检索等同于必须配置所有辅助服务。');

renderers.general = () => head('通用','常用偏好集中在一起，平台能力按当前设备显示。')+
 section('语言与时间',row('语言',select('语言',['简体中文','English','繁體中文','日本語']))+row('时间格式',select('时间格式',['24 小时','12 小时']))+row('每周开始于',select('周起始',['星期一','星期日'])))+
 section('启动与窗口',row('登录时启动',toggle('登录时启动',false),'桌面本地环境提供此选项。')+row('关闭窗口后保留托盘',toggle('保留托盘'))+row('工作时保持唤醒',toggle('保持唤醒',false)))+
 section('访问此应用',objectRow('设备与访问','密码、配对设备和访问撤销在这里管理。','goto:access','shield'))+
 fold('浏览器与移动端','按实际平台显示',field('安装名称','PWA名称','Varin')+row('屏幕方向',select('方向',['跟随设备','竖屏','横屏']))+row('键盘布局',select('键盘布局',['自动','调整可见区域'])),'');

renderers.notifications = () => head('通知','先决定什么时候提醒，再调整提醒的样子。',btn('发送测试','test-notification','ghost','bell'))+
 `<div class="preview-layout"><div>${
 section('发送方式',row('系统通知',toggle('系统通知'))+row('应用在前台时也提醒',toggle('前台通知',false)))+
 section('提醒事件',row('本轮完成',toggle('完成提醒'))+row('子任务返回',toggle('子任务提醒'))+row('发生错误',toggle('错误提醒'))+row('需要回答',toggle('问题提醒')))+
 fold('通知文案','按事件分别编辑',row('事件',select('通知事件',['本轮完成','子任务返回','发生错误','需要回答']))+field('标题模板','通知标题','需要你的回答')+area('通知内容','{message}'))+
 fold('浏览器推送','当前浏览器的订阅',row('订阅推送',toggle('推送',false),'仅在支持的浏览器环境显示。'))
 }</div><aside class="preview"><div class="preview-label"><span>通知预览</span><span>示例内容</span></div><div class="preview-window" style="padding:20px"><div class="actions small muted">${icon('bell')} Varin <span style="margin-left:auto">现在</span></div><h3 style="margin:14px 0 6px">需要你的回答</h3><p class="small muted">计划面板更新时，如何处理正在编辑的草稿？</p></div><p class="preview-footer">通知最终使用系统样式；是否显示取决于系统通知权限。</p></aside></div>`;

const speechModels=[
 ['whisper-turbo','Whisper large-v3 Turbo','100 种语言','564 MB',true],
 ['qwen-asr','Qwen3-ASR 0.6B','30 种语言','879 MB'],
 ['sensevoice','SenseVoice Small','中文 · 英语 · 日语 · 韩语 · 粤语','166 MB'],
 ['parakeet-v2','Parakeet v2','英语','483 MB'],
 ['parakeet-v3','Parakeet v3','25 种语言','488 MB'],
 ['whisper-base','Whisper base','99 种语言','208 MB'],
 ['whisper-tiny','Whisper tiny','99 种语言','117 MB']
];
function speechModelGrid(){
 return '<div class="speech-model-grid" role="group" aria-label="本地语音识别模型">'+speechModels.map(([id,name,languages,size,preferred])=>{
 const selected=val('本地语音模型','whisper-turbo')===id;
 return `<div class="speech-model ${selected?'selected':''}">
 <button class="speech-model-select" data-choice="${id}" data-key="本地语音模型" aria-pressed="${selected}">
 <span class="radio-dot"></span><span><strong>${name} ${preferred?tag('默认'):''}</strong><small>${languages}</small><small>下载 ${size}</small></span></button>
 <button class="icon-button speech-model-download" data-action="speech-download:${id}" aria-label="下载 ${name}"><svg class="i" viewBox="0 0 24 24"><path d="M12 3v13m-5-5 5 5 5-5M5 20h14"/></svg></button></div>`;
 }).join('')+'</div>';
}
renderers.voice = () => head('语音','分别设置回答朗读和语音输入。')+
 '<div class="page-nav"><button data-anchor="voice-playback">朗读</button><button data-anchor="voice-input">语音输入</button></div>'+
 '<div id="voice-playback">'+section('朗读',row('启用朗读',toggle('朗读启用',false))+
 (val('朗读启用',false)?row('播放提供方',select('播放提供方',['浏览器语音','本地模型','OpenAI','OpenAI 兼容','macOS say']))+
 row('声音',select('朗读声音',['跟随提供方默认','已安装声音']))+row('输入内容',select('朗读内容',['完整回答','摘要']))+
 `<div class="resource-line">${icon('sound')}<div><p>准备好后，可以继续下一步。</p><small>点击试听，听听当前声音与语速。</small></div>${btn('试听','voice-preview','','sound')}</div>`+
 fold('声音参数','语速、音调与音量',row('语速',input('语速','1','range','min="0.5" max="2" step="0.1"'))+row('音调',input('音调','1','range','min="0.5" max="2" step="0.1"'))+row('音量',input('音量','80','range','min="0" max="100"'))):''))+'</div>'+
 '<div id="voice-input">'+section('语音输入',row('启用语音输入',toggle('听写启用',true))+
 (val('听写启用',true)?row('识别提供方',select('识别提供方',['本地模型','OpenAI 兼容服务']))+
 (val('识别提供方','本地模型')==='本地模型'?'<div class="small-label" style="margin:22px 0 8px">模型</div>'+speechModelGrid():
 field('服务地址','STT地址','http://localhost:8001/v1')+field('API Key','STT密钥','','按服务要求填写。','password')+field('模型 ID','STT模型','')+
 fold('停止识别条件','静音检测与持续时间',row('静音阈值',numbered('-40','dB','静音阈值'))+row('保持时间',numbered('1000','ms','静音保持'))))+
 row('语言',select('识别语言',['自动检测','中文','English'])):''))+'</div>';

renderers.shortcuts = () => head('快捷键','直接按动作查找，点击键位录入新的组合。',btn('恢复默认','reset-shortcuts','ghost'))+
 `<div class="list-toolbar">${input('搜索快捷键','','search','placeholder="搜索动作或快捷键" data-list-filter')}<span>点击键位开始录入</span></div><table class="table"><thead><tr><th>动作</th><th style="width:32%">快捷键</th><th style="width:60px"></th></tr></thead><tbody>${[
 ['新建会话','Ctrl N'],['搜索会话','Ctrl K'],['打开设置','Ctrl ,'],['显示 / 隐藏侧栏','Ctrl B'],['发送消息','Enter'],['换行','Shift Enter'],['打开命令面板','Ctrl Shift P']
 ].map(([name,key])=>`<tr data-filter-text="${name} ${key}"><td>${name}</td><td><button data-action="record-shortcut:${name}" aria-label="录入 ${name} 的快捷键">${key.split(' ').map(v=>'<kbd>'+v+'</kbd>').join(' ')}</button></td><td><button class="icon-button" data-action="reset-shortcut" aria-label="恢复默认快捷键">${icon('refresh')}</button></td></tr>`).join('')}</tbody></table>`+
 '<p class="hint">录入时按 Esc 取消。发生冲突时，可以重新录入或替换原动作的快捷键。</p>';

renderers.history = () => head('历史与恢复','会话记录和文件恢复历史有不同的保留方式。')+
 section('会话记录',row('自动清理旧会话',toggle('自动清理会话',false))+
 (val('自动清理会话',false)?row('保留时间',numbered('30','天','会话保留')):'')+
 '<div class="actions" style="margin-top:12px">'+btn('查看清理范围','history-cleanup')+'</div>')+
 section('文件恢复历史',row('存储位置',select('恢复位置',['应用数据目录','自定义目录']))+
 '<p class="hint mono">C:\\Users\\…\\AppData\\Roaming\\Varin\\recovery</p>'+
 fold('更改位置','选择目录与迁移',field('目标目录','恢复目标','D:\\VarinData\\recovery')+btn('选择目录','folder-picker')+' '+btn('预览迁移','recovery-move'))+
 row('全局保留期限',numbered('30','天','恢复保留'))+
 '<div class="actions" style="justify-content:flex-end;margin-top:14px">'+btn('保存保留设置','save-section:history')+'</div>')+
 section('工作区覆盖',objectRow('opencr','沿全局位置与保留策略。','recovery-workspace','folder')+objectRow('查看实际占用','统计和可回收内容由存储页提供。','goto:storage','database'));

renderers.projects = () => head('项目','设置项目身份、工作目录和启动动作。')+
 `<div class="split"><aside class="subnav"><button class="active" data-action="project:opencr">${icon('folder')} opencr<small>D:\\project\\opencr</small></button><button data-action="project:Design Lab">${icon('folder')} Design Lab<small>D:\\work\\design</small></button>${btn('添加项目','project-add','ghost','plus')}</aside><div>${
 tabs([['identity','项目'],['folders','目录'],['actions','启动动作'],['worktree','工作副本']],state.tabs.project||'identity','project')+
 ((state.tabs.project||'identity')==='identity'?
 '<div class="object-heading"><span class="avatar blue">'+icon('folder')+'</span><div><h2>'+esc(state.selected||'opencr')+'</h2><small class="muted">项目身份即时保存</small></div></div>'+
 field('显示名称','项目名称',state.selected||'opencr')+row('项目图标',btn('选择图标','project-icon','ghost'))+
 row('强调色','<div class="actions">'+['#a8bfa4','#9aafc6','#c9ac8d','#b5a1bf'].map(c=>'<button class="swatch" style="background:'+c+'" data-action="color-pick" aria-label="选择颜色 '+c+'"></button>').join('')+'</div>')+
 section('默认行为',row('默认模型',modelSelect('项目模型'))+row('工作侧重',select('工作侧重',['继承默认','通用','科研']))):
 state.tabs.project==='folders'?section('项目目录',objectRow('D:\\project\\opencr','默认目录','folder-picker','folder',tag('默认'))+objectRow('D:\\notes\\opencr','附加目录','folder-picker','folder',btn('移除','remove-folder','ghost'))+'<div class="actions" style="margin-top:18px">'+btn('添加目录','folder-picker','ghost','plus')+btn('保存目录','save-section:folders')+'</div>','可排序并指定默认目录。'):
 state.tabs.project==='actions'?section('启动动作',objectRow('打开项目文档','URL · https://docs.example.test','project-action','globe')+objectRow('开发服务','命令 · pnpm dev','project-action','terminal')+btn('添加动作','project-action','ghost','plus'),'进入项目时，可以打开链接、转发端口或运行命令。'):
 section('工作副本',row('自动创建工作副本',toggle('自动工作副本',false))+field('设置等待时间','worktree等待','30','','number')+fold('仓库设置','沿当前项目保存',area('worktree设置','{\n  "setup": []\n}','reading-editor code'))+btn('保存工作副本设置','save-section:worktree')))
 }</div></div>`;

renderers.editor = () => head('编辑器','阅读尺度与编辑行为分组，代码预览保持可见。')+
 `<div class="preview-layout"><div>${
 section('字体与阅读',row('等宽字体',select('等宽字体',['Cascadia Code','Consolas','系统等宽字体']))+row('字号',numbered('13','px','编辑字号'))+row('自动换行',toggle('编辑器换行',true))+row('缩略图',toggle('缩略图',false))+row('空白字符',select('空白字符',['仅选中时','全部','不显示'])))+
 section('编辑行为',row('键位',select('编辑器键位',['默认','Vim']))+row('缩进宽度',numbered('2','空格','缩进宽度'))+row('使用空格缩进',toggle('空格缩进'))+row('自动保存',select('自动保存',['关闭','失去焦点时','延迟保存'],'关闭'))+row('展开工具栏',toggle('展开编辑器工具栏',false)))
 }</div><aside class="preview"><div class="preview-label">代码阅读预览</div><div class="preview-window"><div class="preview-top">${icon('code')}<span>ThreadPlan.tsx</span></div><pre style="padding:24px;min-height:270px;color:var(--muted)">1  export function Plan() {
2    const [draft, setDraft] =
3      useState(plan.content);
4
5    return (
6      &lt;PlanEditor
7        value={draft}
8        onChange={setDraft}
9      /&gt;
10   );
11 }</pre></div></aside></div>`;

renderers.terminal = () => head('终端','选择默认 Shell，调整终端的阅读方式。')+
 `<div class="preview-layout"><div>${
 section('Shell',row('默认 Shell',select('默认Shell',['自动选择','PowerShell','Git Bash','WSL']))+row('使用登录 Shell',toggle('登录Shell',false)))+
 section('阅读',row('字号',numbered('13','px','终端字号'))+row('等宽字体',route('在编辑器设置中调整','editor'))+row('快捷按键',toggle('终端快捷按键',false),'仅在支持的设备显示。'))
 }</div><aside class="preview"><div class="preview-label">终端预览</div><div class="preview-window"><div class="preview-top">${icon('terminal')}<span>PowerShell</span></div><pre style="padding:23px;min-height:245px"><span style="color:var(--green)">PS D:\\project\\opencr&gt;</span> git status

On branch main
Your branch is up to date.

nothing to commit, working tree clean

<span style="color:var(--green)">PS D:\\project\\opencr&gt;</span> ▍</pre></div></aside></div>`;

renderers.git = () => head('Git','账号、提交身份与变更显示分别管理。')+
 section('GitHub',`<div class="object-row">${logo('github-copilot')}<div class="object-main" style="flex:1"><strong>GitHub 账号</strong><small>连接后可使用 GitHub 项目与协作功能</small></div>${btn('连接账号','github-connect')}</div>`)+
 section('提交身份',`<table class="table"><thead><tr><th>身份</th><th>邮箱</th><th style="width:20%">使用方式</th><th style="width:45px"></th></tr></thead><tbody><tr><td>个人</td><td><code>you@example.test</code></td><td>默认</td><td><button class="icon-button" data-action="git-identity" aria-label="编辑身份">${icon('edit')}</button></td></tr><tr><td>工作</td><td><code>work@example.test</code></td><td>按需选择</td><td><button class="icon-button" data-action="git-identity" aria-label="编辑身份">${icon('edit')}</button></td></tr></tbody></table><div class="actions" style="margin-top:17px">${btn('添加身份','git-identity','ghost','plus')}${btn('导入发现的身份','git-import','ghost')}</div>`)+
 section('变更显示',row('文件列表',select('Git列表',['目录树','平铺']))+row('提交信息 Gitmoji',toggle('Gitmoji',false))+row('显示被忽略文件',toggle('Git忽略文件',false)));

renderers.languages = () => head('语言支持','查看项目语言的结构支持，准备编辑器所需的语言服务。',btn('刷新','language-refresh','ghost','refresh'))+
 `<div class="actions" style="margin-bottom:24px">${select('语言工作区',['opencr','选择工作区…'])}<span class="small muted">Local · 当前主机</span></div>`+
 section('语言与结构支持',`<table class="table"><thead><tr><th>语言</th><th>结构提取</th><th>支持包</th><th style="width:115px"></th></tr></thead><tbody>${[
 ['TypeScript / JavaScript','Tree-sitter','已安装'],['Rust','Tree-sitter','已安装'],['Python','Tree-sitter','待准备'],['其他已检测语言','按实际目录','查看支持']
 ].map(([n,t,s])=>`<tr><td>${n}</td><td>${t}</td><td>${s}</td><td>${btn('查看','language-detail','ghost')}</td></tr>`).join('')}</tbody></table><div class="actions" style="margin-top:18px">${btn('导入支持包','language-import','ghost','plus')}</div>`,
 '结构提取用于阅读完整代码单元；编辑器语言服务提供跳转、诊断等能力。')+
 fold('编辑器语言服务','与 Agent 工具区分',objectRow('工作区语言服务','查看当前工作区的实际服务状态、准备结果和错误。','language-service','code'));

renderers.computers = () => head('计算机使用','桌面身份与运行状态保留在同一行，打开前先看清目标。',btn('刷新','computer-refresh','ghost','refresh'))+
 section('默认目标',row('默认桌面',select('默认桌面',['不指定','Local · 当前桌面','测试桌面'])),'对话未指定桌面时使用这个目标。')+
 section('可用桌面',objectRow('Local · 当前桌面','此电脑 · 当前会话','desktop-detail','monitor',tag('可用 · 示例'))+objectRow('测试桌面','远端主机 · 已停止','desktop-detail','monitor',tag('已停止'))+objectRow('离线桌面','保留已知身份；连接恢复后读取状态。','desktop-detail','monitor',tag('不可用')))+
 route('管理工作连接','connections');

renderers.connections = () => head('工作连接','Agent 在哪里执行，文件来自哪里，桌面位于哪里。')+
 `<div class="route-map"><div class="route-node"><div class="small-label">当前界面</div>${icon('monitor')}<p>此设备</p><small>正在使用 Varin 桌面版</small></div>${icon('arrow')}<div class="route-node current"><div class="small-label">Agent 主机</div>${icon('layers')}<p>${state.host}</p><small>当前选择的执行主机</small></div></div>`+
 tabs([['host','Agent 主机'],['resources','资源与桌面']],state.tabs.connections||'host','connections')+
 ((state.tabs.connections||'host')==='host'?section('主机连接',objectRow('Local','在此电脑执行 Agent 任务','host','monitor',tag('当前选择'))+objectRow('Workspace Host','直接连接 · https://host.example.test','goto:remote','cloud'))+
 section('连接管理',objectRow('远端实例','SSH 与直接 Host 连接','goto:remote','link')+objectRow('设备与访问','配对、访问与撤销','goto:access','shield')+objectRow('外部隧道','外部入口与活动会话','goto:tunnel','globe')):
 section('当前会话的来源',`<div class="note"><strong>opencr</strong><br>D:\\project\\opencr<br>来源在会话受理时固定；切换主机不改写已经固定的来源。</div>`)+
 section('资源与桌面',objectRow('文件来源','在对话中选择已准入的资源来源。','resource-detail','folder')+objectRow('Local 桌面','由计算机服务提供状态。','goto:computers','monitor')));

renderers.remote = () => {
 if(state.detail==='ssh') return head('Workspace SSH','编辑这个实例；连接操作与配置保存分别进行。',btn('查看日志','connection-log','ghost','terminal'))+
 `<div class="actions" style="margin-bottom:24px"><span class="status">未连接 · 示例</span>${btn('连接','connect-instance','','link')}</div>`+
 section('连接',field('名称','SSH名称','Workspace SSH')+field('SSH 命令','SSH命令','ssh dev@host.example.test','可填写 SSH 别名或完整连接命令。'))+
 section('远端 Varin',row('管理方式',select('远端管理',['由 Varin 管理','使用已有服务']))+row('安装方式',select('安装方式',['Release','bun','npm','上传安装包']))+field('首选端口','首选端口','3000','','number'))+
 fold('超时与认证','连接等待与身份认证',field('连接超时 · 秒','SSH超时','30','','number')+field('认证参数','SSH认证',''))+
 fold('端口转发','添加与管理转发',objectRow('本地 8080 → 远端 8080','仅作配置示例','port-forward','link'))+btn('移除实例','remove-instance','danger ghost');
 return head('远端实例','SSH 实例与直接 Host 连接采用各自的连接流程。',btn('添加连接','remote-add','primary','plus'))+
 section('SSH 实例',objectRow('Workspace SSH','ssh dev@host.example.test','ssh-detail','terminal',tag('未连接'))+objectRow('Build Server','ssh build@build.example.test','ssh-detail','terminal',tag('连接失败 · 示例')))+
 section('直接 Host',objectRow('Workspace Host','https://host.example.test','direct-host','cloud',tag('未探测'))+objectRow('Local','本地主机','host','monitor',tag('默认')))+
 '<div class="actions" style="margin-top:16px">'+btn('导入配对链接','pairing-import','ghost','link')+btn('手动填写地址','direct-host','ghost')+'</div>';
};

renderers.network = () => head('出站网络','管理当前主机访问外部服务时使用的网络出口。')+
 section('网络出口',options('网络模式',[['system','使用系统代理','沿当前主机的系统代理设置。'],['direct','直接连接','应用请求不使用配置的代理。'],['custom','自定义代理','显式填写代理地址与绕过范围。']],'system')+
 (val('网络模式','system')==='custom'?field('代理地址','代理地址','http://127.0.0.1:7890')+field('绕过地址','绕过地址','localhost, 127.0.0.1','多个地址用逗号分隔。'):'')+
 '<p class="hint">模型和 MCP 服务中的独立连接设置可覆盖主机默认配置。</p>')+
 fold('服务级覆盖','按服务管理',objectRow('模型服务','各服务的请求头、路径与代理。','goto:models','cloud')+objectRow('MCP','各服务的传输与连接参数。','goto:mcp','plug'));

renderers.access = () => head('设备与访问','每个访问入口对应一个可查看、可撤销的设备身份。',btn('配对设备','pair-device','primary','plus'))+
 section('当前设备',objectRow('此电脑','桌面本地连接','device-detail','monitor',tag('当前设备')))+
 section('已配对设备',objectRow('移动设备','最近使用：刚刚 · 中继连接（示例）','device-detail','monitor',btn('撤销访问','revoke-device','ghost'))+
 objectRow('浏览器客户端','最近使用：昨天 · 直接连接（示例）','device-detail','globe',btn('撤销访问','revoke-device','ghost')),
 '最近使用显示该设备上次访问主机的时间。')+
 fold('待完成的配对','1 项',objectRow('新的移动设备','等待设备完成配对','pair-device','link',btn('取消','cancel-pairing','ghost')))+
 section('本机访问',row('访问密码',btn('更改密码','access-password'),'用于从其他设备访问本机。')+row('局域网访问',toggle('局域网访问',false)));

renderers.tunnel = () => {
 const active=val('隧道运行',false);
 return head('外部隧道','建立临时或托管入口，从其他设备访问当前主机。')+
 section('当前入口',`<div class="resource-line">${icon('globe')}<div><p>${active?'https://demo.example.test':'隧道未启动'}</p><small>${active?'示例入口 · 不可用于实际连接':'启动后在此展示真实地址与有效期。'}</small></div><span class="status ${active?'ok':''}">${active?'运行中 · 示例':'空闲'}</span></div><div class="actions" style="margin-top:16px">${btn(active?'停止隧道':'启动隧道',active?'tunnel-stop':'tunnel-start',active?'':'primary','globe')}${active?btn('连接信息','tunnel-info','ghost'):''}</div>`)+
 section('连接方式',row('模式',select('隧道模式',['快速隧道','托管远端','托管本地']))+
 (val('隧道模式','快速隧道')==='托管远端'?row('远端配置',select('远端隧道配置',['选择已有配置','新增配置…']))+field('凭据','隧道凭据','','已保存凭据不回显。','password'):
 val('隧道模式','快速隧道')==='托管本地'?field('本地配置文件','隧道配置文件','')+btn('选择文件','folder-picker'):
 '<p class="hint">快速创建临时入口，无需预先配置域名。</p>'))+
 fold('会话有效期','引导与会话分别配置',row('引导有效期',numbered('15','分钟','引导有效期'))+row('会话有效期',numbered('60','分钟','会话有效期')))+
 section('活动会话',active?objectRow('移动设备','通过当前隧道访问 · 示例','device-detail','monitor'):'<p class="hint">暂无活动会话。</p>');
};

renderers.mcp = () => {
 const name=state.selected||'Documentation', tab=state.tabs.mcp||'tools';
 return head('MCP','连接状态、配置来源与可用工具在所选服务旁查看。',btn('添加服务','mcp-add','','plus'))+
 `<div class="actions" style="margin-bottom:24px">${select('MCP配置来源',['用户配置','项目 · opencr'])}<span class="small muted">更改保存到所选配置文件</span></div><div class="split"><aside class="subnav"><button class="${name==='Documentation'?'active':''}" data-action="mcp-select:Documentation">${icon('plug')} Documentation<small>已连接 · 3 个工具</small></button><button class="${name==='Design tools'?'active':''}" data-action="mcp-select:Design tools">${icon('plug')} Design tools<small>等待授权</small></button><button class="${name==='Local tools'?'active':''}" data-action="mcp-select:Local tools">${icon('plug')} Local tools<small>连接失败</small></button></aside><div><div class="object-heading"><div><h2>${name}</h2><small class="muted">${val('MCP配置来源','用户配置')} · 示例状态</small></div><div class="actions">${btn(name==='Design tools'?'授权登录':'重新连接',name==='Design tools'?'mcp-auth':'mcp-connect','ghost')}</div></div>${
 tabs([['tools','工具'],['config','配置'],['diagnostics','状态与诊断']],tab,'mcp')+
 (tab==='tools'?`<p class="hint" style="margin-bottom:15px">当前连接提供的工具</p><table class="table"><thead><tr><th style="width:42%">工具</th><th>说明</th></tr></thead><tbody><tr><td><code>search</code></td><td>搜索文档</td></tr><tr><td><code>read_page</code></td><td>读取指定页面</td></tr><tr><td><code>list_sources</code></td><td>列出可用文档来源</td></tr></tbody></table>`:
 tab==='config'?field('服务名称','MCP名称',name)+row('传输',select('MCP传输',['HTTP','stdio']))+field('地址 / 命令','MCP地址','https://mcp.example.test')+
 fold('请求与环境参数','请求头、环境变量',area('MCP环境','{\n  "headers": {},\n  "env": {}\n}','reading-editor code'))+
 fold('原始 JSONC','编辑同一份配置文档',area('MCPJSONC','{\n  "servers": {\n    "docs": { "url": "https://mcp.example.test" }\n  }\n}','reading-editor code')):
 section('连接状态','<span class="status '+(name==='Local tools'?'bad':name==='Design tools'?'warn':'ok')+'">'+(name==='Local tools'?'连接失败':name==='Design tools'?'等待授权':'已连接')+' · 示例</span><p class="hint">连接后刷新工具目录；配置修改后可重新连接。</p>')+fold('配置来源与覆盖','用户配置',`<pre>用户配置 → ${name}\n项目覆盖：无\n目录来源：当前连接</pre>`)+btn('断开连接','mcp-disconnect','ghost'))
 }</div></div>`;
};

renderers.skills = () => {
 const name=state.selected||'code-review', readonly=name==='builtin-guide';
 return head('Skills','查看 Skill 内容，编辑个人或项目的工作方法。',btn('新建 Skill','skill-add','','plus'))+
 `<div class="actions" style="margin-bottom:22px">${select('Skill范围',['用户','项目 · opencr'])}${input('筛选Skill','','search','placeholder="筛选 Skill" style="max-width:220px" data-list-filter')}</div><div class="split"><aside class="subnav"><div class="subheading">用户资源</div><button class="${name==='code-review'?'active':''}" data-filter-text="code-review" data-action="skill:code-review">${icon('bolt')} code-review<small>SKILL.md · 可编辑</small></button><button class="${name==='writing'?'active':''}" data-filter-text="writing" data-action="skill:writing">${icon('bolt')} writing<small>SKILL.md · 可编辑</small></button><div class="subheading">内置资源</div><button class="${readonly?'active':''}" data-filter-text="builtin-guide" data-action="skill:builtin-guide">${icon('box')} builtin-guide<small>只读 · 可复制</small></button></aside><div><div class="editor-title"><h2>${name}</h2>${tag(readonly?'只读':'可编辑')}${btn('来源','resource-source','ghost')}</div><div class="editor-breadcrumb">${readonly?'内置扩展资源':'用户 / skills'} / ${name} / SKILL.md</div>
 ${readonly?'<pre class="reading-editor code"># 内置使用指南\n\n保持原资源只读。可复制到用户或项目范围后修改。</pre>':area('Skill正文','---\nname: '+name+'\ndescription: Review code with concrete evidence.\n---\n\n# Code review\n\nRead the changed code and its callers.\nReport actionable issues with file references.\n','reading-editor code')}
 <div class="actions" style="margin-top:16px">${btn('复制到…','resource-copy','ghost')}${btn('刷新','resource-refresh','ghost','refresh')}${readonly?'':btn('删除 Skill','resource-delete','danger ghost')}</div></div></div>`;
};

renderers.commands = () => head('Commands','已启用、有效的 Skill 提供这些斜杠命令。')+
 `<div class="list-toolbar">${select('命令范围',['用户与当前项目','仅用户','项目 · opencr'])}${input('搜索命令','','search','placeholder="搜索命令" data-list-filter')}</div><table class="table"><thead><tr><th style="width:36%">命令</th><th>来自 Skill</th><th style="width:80px"></th></tr></thead><tbody>${
 [['/skill:code-review','code-review','审阅代码并提供依据'],['/skill:writing','writing','整理与润色文稿']].map(([c,n,d])=>`<tr data-filter-text="${c} ${d}"><td><code>${c}</code></td><td>${d}<br><span class="faint small">${n} / SKILL.md</span></td><td>${btn('查看','skill-route:'+n,'ghost')}</td></tr>`).join('')
 }</tbody></table><p class="hint">命令名称沿实际资源目录生成。编辑原 Skill 后由同一资源目录反映变化。</p>`;

renderers.extensions = () => {
 const tab=state.tabs.extension||'installed';
 return head('Varin 扩展','为工作台添加能力，管理服务和工作台配置。',btn('安装扩展','extension-install','','plus'))+
 tabs([['installed','已安装'],['routing','服务路由'],['profiles','工作台配置']],tab,'extension')+
 (tab==='installed'?[
 ['Agent Workspace','内置 · 当前工作台','已启用'],['IDE Workspace','内置 · 编辑与开发','已启用'],['Research Workspace','内置 · 科研工作台','已启用'],['Example integration','本地目录 · 有新候选','待审阅']
 ].map(([n,d,s])=>`<div class="object-row">${icon('box')}<button class="object-main" data-action="extension-detail:${n}"><strong>${n}</strong><small>${d}</small></button><span class="status ${s==='待审阅'?'warn':''}">${s}</span>${s==='待审阅'?btn('审阅','extension-review'):toggle('启用-'+n,true,n)}</div>`).join('')+
 '<p class="hint">更改启用选项后可在扩展详情中查看运行结果。</p>':
 tab==='routing'?section('服务路由',`<div class="actions" style="margin-bottom:20px">${select('路由范围',['用户','工作区 · opencr'])}</div>`+
 row('文件编辑器',select('文件编辑器服务',['当前默认','已注册的替代服务']))+row('文档阅读',select('文档阅读服务',['当前默认','已注册的替代服务']))+row('其他已声明服务',btn('查看服务目录','service-directory','ghost'))):
 section('当前工作台',row('配置',select('工作台配置',['Agent Workspace','IDE Workspace','Research Workspace']))+objectRow('Shell 与替代服务','选择界面与注册服务的实现。','profile-detail','layers')+fold('扩展集','按配置显式应用',`<p class="hint">编辑配置不会自动应用整套启停状态。</p>${btn('应用扩展集','profile-apply')}`)+
 '<div class="actions" style="margin-top:20px">'+btn('新建配置','profile-new','ghost','plus')+btn('移除配置','profile-delete','danger ghost')+'</div>'));
};

renderers.about = () => `<div style="padding:28px 0 45px"><div class="brand" style="font-size:32px;margin-bottom:10px">${icon('layers')} Varin</div><p class="muted">独立的 Agent 工作台</p><p class="small muted" style="margin-top:15px">版本按当前应用信息显示 · 此处为设计示例</p><div class="actions" style="margin-top:23px">${btn('检查更新','app-update')}${btn('复制诊断信息','copy-diagnostics','ghost')}</div></div>`+
 section('项目与开源',objectRow('项目主页','代码、问题与发布记录。','project-site','globe')+objectRow('开源许可','保留 LICENSE 与第三方声明。','licenses','doc'))+
 section('运行信息','<p class="hint">应用版本、运行环境与主机版本分别显示。日志和诊断按现有入口导出。</p>');

const designNotes = {
 general:['按平台显示启动与窗口偏好','语言与时间成组，访问管理导航到原页面。'],
 appearance:['现有主题预览与字体配置','选择与效果并置，字号、留白、窗口依次展开。'],
 chat:['真实聊天预览、三种模式和细分偏好','预览继续就近联动；思考与工具、阅读、输入各有归属。'],
 sessions:['主机 / 项目继承和独立重试保存','先默认模型，再请求策略，设备偏好单独标明。'],
 notifications:['事件分类、测试通知和模板','事件开关直达，文案在对应预览旁编辑。'],
 voice:['现有语音分区与本地模型卡片','保留两列模型选择、语言覆盖、大小和下载操作；窄屏改单列。'],
 shortcuts:['按动作录入、冲突处理、恢复默认','可扫描的动作表，键位在原行编辑。'],
 storage:['分类占用、设备范围和清理预览','保留数据构成，强调可清理对象及实际回执。'],
 history:['会话与文件恢复各自的保存单元','保留期、位置迁移和项目覆盖在原领域内组织。'],
 models:['品牌、模型集合、完整模型详情与测试','服务内先看模型；连接与认证独立，参数保留按需入口。'],
 agents:['头像库、内置配置与分栏编辑','身份在顶部，指令占充分空间；工具从实际目录选择。'],
 bots:['Bot 目录、工作线程和记忆偏好','配置、工作、记忆各自有完整视图，避免运行状态挤进表单。'],
 prompt:['范围选择、自定义指令与组合预览','保留正文编辑空间，系统生成内容明确只读。'],
 memory:['记忆正文、作用域与来源','编辑替换原条目，来源弱化到可展开层，避免重复编辑区。'],
 tools:['工具、执行参数与 Agent 选择入口','使用真实能力目录；修正旧键无效开关后再落地控制。'],
 embeddings:['本地模型与远端来源、CPU 和请求设置','选来源后展示相关依赖，模型资源和请求资源分别管理。'],
 web:['搜索服务、动态渲染、辅助模型与组件参数','保留常用选择，组件路径跟随文档能力展开。'],
 images:['生成 / 编辑各自的模型选择','两种用途并列理解，不额外增加未经支持的图像设置。'],
 computers:['桌面目录、实际状态与默认目标','在具体桌面行查看和处理问题。'],
 permissions:['规则顺序、参数匹配、项目约束','默认策略与规则表分层，支持单条编辑和顺序调整。'],
 context:['预留决定的替换边界与后台压缩准备水位','同一比例条呈现基准压缩点、替换点和预留区；准备可能自适应提前。'],
 projects:['项目选择、身份、目录、动作与工作副本','延续分栏；每类配置有清晰页内入口与保存边界。'],
 editor:['共享字体和编辑偏好','以代码阅读预览连接设置效果，行为项紧凑成组。'],
 terminal:['Shell 选择、字号与快速按键','保留终端样式预览，共享字体明确导航。'],
 git:['GitHub、身份档案、变更偏好','三种对象分别呈现，身份按表格进行 CRUD。'],
 retrieval:['普通检索模型及现有可选配置','主路径只需理解检索模型，重排与快速决策独立展开。'],
 languages:['工作区检测、支持包与语言服务','区分结构提取与编辑器服务；显示真实准备和错误结果。'],
 connections:['Agent / 资源视图与来源固定语义','用关系图说明位置，实际管理仍回到对应连接对象。'],
 remote:['SSH 实例与 Direct Host 两套流程','分类列出对象，实例编辑保留连接、日志和显式保存。'],
 network:['系统 / 直连 / 自定义出口','模式选择带简短影响，自定义依赖就地出现。'],
 access:['配对、设备、近期访问与撤销','设备身份是主角，访问活跃与连接状态保持准确含义。'],
 tunnel:['quick / managed 模式与活动会话','先当前入口，再模式配置，再活动会话。'],
 mcp:['配置来源、JSONC、认证和工具目录','服务目录与详情配对，配置保存和连接操作明确分开。'],
 skills:['原始资源目录、SKILL.md、只读和复制','延续目录与正文编辑，不把 Skill 改成开关卡片。'],
 commands:['从有效 Skill 投影出的只读命令目录','保留来源导航，不虚构第二份命令管理。'],
 extensions:['扩展生命周期、候选审阅、服务路由、工作台','四类复杂操作各自有入口；启用意图与实际状态分开。'],
 about:['版本、更新与许可入口','保留简洁品牌呈现，技术诊断只在需要时展开。']
};
const fieldKeywords = {
 general:'language 语言 时间 启动 托盘 PWA 键盘',appearance:'主题 theme 字体 字号 密度 圆角 透明',
 chat:'对话优先 思考 自动展开 换行 差异 草稿 输入 预览',sessions:'重试 retry 默认模型 辅助模型 标题',
 notifications:'通知 测试 前台 模板 推送',voice:'语音 朗读 听写 TTS STT 静音',shortcuts:'按键 shortcut 快捷键',
 storage:'占用 清理 空间 磁盘 副本',history:'历史 恢复 位置 迁移 保留期限',models:'API Key OAuth 服务 模型 token 上下文 tokenizer 协议 参数 缓存 路径',
 agents:'Agent 工具 指令 头像 派发 工作副本',bots:'Bot 工作线程 记忆',prompt:'系统 提示词 指令 组合',memory:'记忆 来源 笔记',
 tools:'终端 工具 执行 Shell 目录',embeddings:'嵌入 本地模型 CPU 向量 并发',web:'搜索 OCR tesseract docling 文档 域名 网页',
 images:'图像 图片 生成 编辑',computers:'桌面 computer 计算机',permissions:'授权 允许 规则 策略 拒绝',context:'上下文 整理 预留 恢复',
 projects:'项目 名称 图标 目录 动作 worktree 工作副本',editor:'编辑器 vim 字体 自动保存 缩进 空白',terminal:'shell 终端 powershell wsl bash',
 git:'GitHub 身份 邮箱 gitmoji',retrieval:'检索 重排 决策',languages:'语言 支持包 tree-sitter LSP',
 connections:'工作连接 Agent Host 来源 桌面',remote:'SSH 远端 地址 端口 转发 配对',network:'网络 代理 proxy 出站',access:'设备 访问 密码 配对 passkey',
 tunnel:'隧道 外网 TTL 连接',mcp:'MCP JSONC 认证 工具 服务',skills:'Skill SKILL.md 技能 资源',commands:'commands 斜杠 命令',extensions:'扩展 路由 工作台 profile 安装',about:'版本 更新 开源 许可'
};
function guide(){
 return head('完整设置设计','37 个可进入页面。依据当前注册目录与页面实现组织，示例值不表示用户的实际配置。')+
 `<div class="doc-grid"><div class="guide-block"><h3>延续已有设计</h3><p>聊天与外观的效果预览、Agent 头像、模型品牌与模型详情、Skills 原文件编辑、存储分类占用、项目分栏都继续保留。优化页面内的层次、路径和操作归属。</p></div><div class="guide-block"><h3>各页按用途设计</h3><p>偏好与预览相邻；对象集合有目录和详情；正文获得充分编辑空间；运行资源强调实际状态与动作；规则保留顺序与范围。</p></div><div class="guide-block"><h3>保存边界</h3><p>即时偏好使用就地反馈。服务、规则和文档有明确保存单元；切换未保存对象先处理草稿。连接、安装、清理与保存配置分别反馈。</p></div><div class="guide-block"><h3>状态与设计边界</h3><p>真实产品只使用 owner 提供的状态。设计稿中的数值、模型、在线状态与结果均为示例；不新增后台探测来填满绿色状态标记。</p></div></div>`+
 section('可操作的状态示例',`<div class="actions">${btn('模型草稿与保存失败','scenario:save') }${btn('主机不可达','scenario:offline')}${btn('清理部分完成','scenario:cleanup')}${btn('快捷键冲突','scenario:shortcut')}${btn('MCP 等待授权','scenario:mcp')}</div>`)+
 section('页面覆盖与保留依据',`<table class="table"><thead><tr><th style="width:17%">页面</th><th style="width:35%">保留基础</th><th>本次设计</th></tr></thead><tbody>${pageSpecs.map(([id,title])=>`<tr><td><button class="text-button" data-go="${id}">${title}</button></td><td>${designNotes[id][0]}</td><td>${designNotes[id][1]}<div class="source-path">${sourceRoot+sourceMap[id]}</div></td></tr>`).join('')}</tbody></table>`)+
 section('需要同步修正的产品事实','<div class="note warn">工具与执行页仍有旧工具名开关。当前原生工具集合并不消费这些旧键；落地新目录控制前，应先修正配置与原生工具准入的连接。设计稿使用当前工具名说明目录结构，不把旧开关伪装成有效控制。</div>')+
 '<p class="hint">本稿只修改设计文件。现有设置实现与用户配置未改动。</p>';
}

const owner = () => state.host+'|'+state.page+'|'+(state.selected||'');
const valueKey = key => owner()+'|'+(state.detail==='model'?(state.modelName||'')+'|':'')+key;
// Values remain in this browser document only; draft and save states are separate.
const draftValues = state.values;
function mark(key,value,documentSave=true){
 const k=valueKey(key);
 const draftChange=(documentSave&&isDocument())||(state.page==='memory'&&state.noteEdit!==null);
 if(draftChange&&!(owner() in state.restored))state.restored[owner()]={...draftValues};
 if(!draftChange&&state.restored[owner()])state.restored[owner()][k]=value;
 draftValues[k]=value;
 if(state.page==='memory'&&state.noteEdit!==null){state.drafts.add(owner());return;}
 if(documentSave && isDocument()) {state.drafts.add(owner());renderFooter();}
 else {$('#save-status').textContent='已保存';clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>{$('#save-status').textContent='';},1600);}
}
function isDocument(){
 if(state.page==='models')return ['service','model'].includes(state.detail);
 if(state.page==='memory')return false;
 if(state.page==='remote')return state.detail==='ssh';
 if(state.page==='mcp')return state.tabs.mcp==='config';
 if(state.page==='skills')return state.selected!=='builtin-guide';
 if(state.page==='bots')return (state.tabs.bot||'profile')==='profile';
 return ['agents','prompt','permissions','network'].includes(state.page);
}
function renderFooter(){
 const dirty=state.drafts.has(owner()), p=pages[state.page];
 $('#footer').hidden=!dirty||state.page==='memory';
 if(dirty)$('#footer').innerHTML=`<div><span>有未保存的更改</span><span class="faint"> · ${p?.title||'当前编辑'}</span><div id="save-error" class="error-inline" role="alert"></div></div>${btn('取消','discard','ghost')}${btn(state.page==='models'?'保存服务':'保存更改','save','primary')}`;
}
function renderNav(){
 const q=$('#search').value.trim().toLowerCase();
 $('#nav').innerHTML=groupTitles.map((g,i)=>{
  const items=pageSpecs.filter(([id,title,group])=>group===i&&(!q||(title+' '+fieldKeywords[id]).toLowerCase().includes(q)));
  if(!items.length)return '';
  return `<div class="nav-group ${!q&&state.navClosed.has(i)?'closed':''}"><button class="nav-group-title" data-group="${i}">${g}${icon('arrow')}</button><div class="nav-links">${items.map(([id,title,,glyph])=>`<button class="nav-link ${state.page===id?'active':''}" data-go="${id}">${icon(glyph)}<span>${title}</span></button>`).join('')}</div></div>`;
 }).join('') || '<p class="hint" style="padding:12px">没有匹配项。可以搜索用途、参数名或页面名称。</p>';
}
function render(keepScroll=false){
 if(contextDrag)finishContextDrag(false);
 const y=$('#scroll').scrollTop, p=pages[state.page];
 const focus=document.activeElement?.getAttribute('data-key');
 $('#page').className='page '+(['appearance','chat','models','agents','projects','skills','mcp','guide','editor','terminal','notifications'].includes(state.page)?'wide':'');
 $('#page').innerHTML=state.page==='guide'?guide():stateNote()+renderers[state.page]();
 const crumbs=state.page==='guide'?[['设计与覆盖','guide']]:[[groupTitles[p.group],null],[p.title,state.page]];
 if(state.page==='models'&&state.detail)crumbs.push([state.detail==='add'?'添加服务':serviceName(state.selected),null]);
 if(state.page==='models'&&state.detail==='model')crumbs.push([state.modelName,null]);
 if(state.page==='remote'&&state.detail==='ssh')crumbs.push(['Workspace SSH',null]);
 $('#breadcrumb').innerHTML=(state.detail?'<button class="icon-button" data-action="back" aria-label="返回">'+icon('back')+'</button>':'')+
 crumbs.map(([label,id],i)=>`${i?icon('arrow'):''}${id&&i<crumbs.length-1?'<button data-go="'+id+'">'+esc(label)+'</button>':'<span class="'+(i===crumbs.length-1?'current':'')+'">'+esc(label)+'</span>'}`).join('');
 $('#scope').innerHTML=p?icon(['此设备','此应用'].includes(p.scope)?'monitor':'layers')+esc(p.scope==='当前主机'?'当前主机 · '+state.host:p.scope):'设计工作稿';
 $('#host-label').textContent=state.host+(state.host==='Local'?' · 此电脑':' · 远端示例');
 $('#save-status').textContent='';
 renderNav();renderFooter();
 $('#scroll').scrollTop=keepScroll?y:0;
 if(keepScroll&&focus){const node=[...$('#page').querySelectorAll('[data-key]')].find(n=>n.dataset.key===focus);node?.focus({preventScroll:true});}
 previewStyle();updateSpecificPreviews();
}
const scrollPositions=new Map();
function go(page,force=false){
 if(!pages[page]&&page!=='guide')return;
 if(state.drafts.has(owner())&&!force){
  pendingNavigation=()=>go(page,true);
  dialog('保留当前更改？','<p>当前编辑单元还有未保存的内容。选择保存或放弃后再离开。</p>',
   [{text:'继续编辑',action:'modal-close'},{text:'放弃更改',action:'nav-discard'},{text:'保存后离开',action:'nav-save',primary:true}]);return;
 }
 scrollPositions.set(state.page,$('#scroll').scrollTop);
 state.page=page;state.detail='';state.selected='';state.modelName='';
 $('#stage').classList.remove('nav-open');history.replaceState(null,'','#'+page);
 render();$('#scroll').scrollTop=scrollPositions.get(page)||0;
 if($('#search').value.trim())focusSearch($('#search').value.trim());
}
function focusSearch(query){
 if(state.page==='models'&&/token|上下文|协议|参数|路径/i.test(query)){
  state.selected='deepseek';state.detail='model';state.modelName='DeepSeek V4.1 Flash';render();
 }
 const node=[...$('#page').querySelectorAll('label,h2,summary,.row-copy>span')].find(n=>n.textContent.toLowerCase().includes(query.toLowerCase()));
 if(node){for(let p=node.parentElement;p&&p!==$('#page');p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;node.scrollIntoView({block:'center',behavior:'smooth'});const old=node.style.color;node.style.color='var(--amber)';setTimeout(()=>{node.style.color=old;},2200);}
}
function toast(text){
 $('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=text;$('.main').append(el);setTimeout(()=>el.remove(),2400);
}
let modalFocus, pendingNavigation, keyRecorder, savedModalCallback;
function dialog(title,body,buttons=[{text:'完成',action:'modal-close',primary:true}]){
 modalFocus=document.activeElement;
 $('#overlays').innerHTML=`<div class="dialog-cover"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="modal-close" aria-label="关闭">×</button></header>${body}<div class="dialog-actions">${buttons.map(b=>btn(b.text,b.action,b.primary?'primary':b.danger?'danger':'ghost')).join('')}</div></section></div>`;
 requestAnimationFrame(()=>$('.dialog input:not([type=checkbox]),.dialog textarea,.dialog select,.dialog .dialog-actions button')?.focus());
}
function closeModal(){
 $('#overlays').innerHTML='';keyRecorder=undefined;savedModalCallback=undefined;
 if(modalFocus?.isConnected)modalFocus.focus({preventScroll:true});
}
function modalInput(label,value='',type='text',name='value'){
 return `<div class="field"><label>${label}</label><input type="${type}" data-local="${name}" value="${esc(value)}" aria-label="${label}"></div>`;
}
function commitDialog(callback){savedModalCallback=callback;}
function simpleEditor(title,body,callback){
 dialog(title,body,[{text:'取消',action:'modal-close'},{text:'保存',action:'modal-commit',primary:true}]);
 commitDialog(callback||(()=>toast('示例更改已保存')));
}
function save(after){
 const own=owner();
 if(state.failNext){state.failNext=false;const error=$('#save-error');if(error)error.textContent='保存失败：示例主机未确认写入。草稿仍保留，可以重试。';$('#save-status').textContent='保存失败';$('#save-status').classList.add('error');return;}
 state.drafts.delete(own);delete state.restored[own];$('#save-status').classList.remove('error');renderFooter();toast('示例：当前编辑单元已保存');if(after)after();
}
function discard(){
 const own=owner(), original=state.restored[own];
 if(original){for(const k of Object.keys(draftValues))if(k.startsWith(own+'|'))delete draftValues[k];for(const [k,v]of Object.entries(original))if(k.startsWith(own+'|'))draftValues[k]=v;}
 state.drafts.delete(own);delete state.restored[own];render(true);
}
function serviceName(id){return ({deepseek:'DeepSeek',anthropic:'Anthropic',openai:'OpenAI',ollama:'本地 Ollama',google:'Google',openrouter:'OpenRouter'})[id]||'DeepSeek';}
function requestObjectChange(callback){
 if(!state.drafts.has(owner()))return callback();
 pendingNavigation=callback;dialog('切换前处理当前草稿','<p>更改属于当前对象。切换不会把内容写入另一个对象。</p>',
 [{text:'继续编辑',action:'modal-close'},{text:'放弃更改',action:'nav-discard'},{text:'保存后切换',action:'nav-save',primary:true}]);
}
function previewStyle(){
 const preview=$('#live-preview');
 if(preview){preview.querySelector('.mini-chat').style.fontSize=(Number(val('界面字号',14))-1)+'px';const padding=val('内容留白','标准');preview.querySelector('.mini-chat').style.padding=padding==='紧凑'?'16px':padding==='舒展'?'27px':'22px 20px';preview.querySelector('.preview-window').style.borderRadius=val('圆角',8)+'px';}
}
function updateContextScale(keepInput=null){
 const scale=$('#context-scale');if(!scale)return;
 const {replace,prepare,waterline}=contextBoundaries();
 scale.style.setProperty('--prepare',prepare+'%');scale.style.setProperty('--replace',replace+'%');
 $('[data-context-label=prepare]').textContent='准备基准 · '+percentText(prepare)+'%';
 $('[data-context-label=replace]').textContent='替换 · '+percentText(replace)+'%';
 $('[data-context-reserve]').textContent=percentText(100-replace)+'%';
 $('[data-context-reserve-note]').textContent='对应预留 '+percentText(100-replace)+'%。';
 $('[data-context-prepare-note]').textContent='对应整个窗口的 '+percentText(prepare)+'%（基准）。';
 $('[data-context-waterline]').textContent=percentText(waterline*100)+'%';
 if(keepInput!==$('#context-prepare'))$('#context-prepare').value=Number((waterline*100).toPrecision(12));
 if(keepInput!==$('#context-replace'))$('#context-replace').value=Number(replace.toPrecision(12));
 for(const kind of ['prepare','replace']){
  const marker=$('[data-context-drag='+kind+']'),isPrepare=kind==='prepare';
  marker.setAttribute('aria-valuenow',String(isPrepare?waterline*100:replace));
  const description=isPrepare?'准备水位 '+percentText(waterline*100)+'%，对应全窗口 '+percentText(prepare)+'%':'全窗口 '+percentText(replace)+'%，预留 '+percentText(100-replace)+'%';
  marker.setAttribute('aria-valuetext',description);marker.title=description;
 }
}
function changeContextBoundary(input){
 const v=Number(input.value),prepare=input.dataset.contextThreshold==='prepare';
 const valid=input.value.trim()!==''&&Number.isFinite(v)&&v>0&&(prepare?v<100:v<=100);
 const error=valid?'':prepare?'准备水位需大于 0%、小于可用输入预算的 100%。':'替换位置需大于 0%，且不超过模型窗口的 100%。';
 input.setCustomValidity(error);$('#context-boundary-error').textContent=error;
 if(!valid)return;
 if(prepare)mark('压缩准备水位',v/100);else mark('上下文预留',100-v);
 updateContextScale(input);
}
// Pointer movement only previews. Releasing commits one value; cancellation restores it.
function clearContextBoundaryError(){
 $('#context-boundary-error').textContent='';
 $('#context-prepare').setCustomValidity('');$('#context-replace').setCustomValidity('');
}
function finishContextDrag(commit){
 const drag=contextDrag;if(!drag)return;
 const preview=state.contextPreview;contextDrag=null;delete state.contextPreview;
 if(drag.marker.hasPointerCapture(drag.pointerId))drag.marker.releasePointerCapture(drag.pointerId);
 drag.marker.classList.remove('dragging');$('#context-scale')?.classList.remove('is-dragging');
 if(commit&&preview&&owner()===drag.ownerKey){
  if(drag.kind==='prepare'&&preview.waterline!==drag.start.waterline)mark('压缩准备水位',preview.waterline);
  if(drag.kind==='replace'&&preview.replace!==drag.start.replace)mark('上下文预留',100-preview.replace);
 }
 updateContextScale();
}
document.addEventListener('pointerdown',event=>{
 const marker=event.target.closest('[data-context-drag]');
 if(!marker||marker.disabled||event.button!==0||!event.isPrimary||contextDrag)return;
 const rect=marker.closest('.context-track').getBoundingClientRect();if(!rect.width)return;
 event.preventDefault();marker.focus({preventScroll:true});clearContextBoundaryError();
 contextDrag={marker,kind:marker.dataset.contextDrag,pointerId:event.pointerId,startX:event.clientX,width:rect.width,start:contextBoundaries(),ownerKey:owner()};
 marker.setPointerCapture(event.pointerId);marker.classList.add('dragging');$('#context-scale').classList.add('is-dragging');
});
document.addEventListener('pointermove',event=>{
 const drag=contextDrag;if(!drag||event.pointerId!==drag.pointerId)return;
 const delta=(event.clientX-drag.startX)/drag.width*100;
 if(delta===0&&!state.contextPreview)return;
 // 0.1 percentage point is a drag step, not a limit on precise numeric input.
 const snap=value=>Math.round(value*10)/10;
 if(drag.kind==='prepare'){
  const percent=Math.max(0.1,Math.min(99.9,snap((drag.start.prepare+delta)/drag.start.replace*100)));
  state.contextPreview={replace:drag.start.replace,waterline:percent/100};
 }else{
  state.contextPreview={replace:Math.max(0.1,Math.min(100,snap(drag.start.replace+delta))),waterline:drag.start.waterline};
 }
 updateContextScale();
});
document.addEventListener('pointerup',event=>{if(contextDrag?.pointerId===event.pointerId)finishContextDrag(true);});
document.addEventListener('pointercancel',event=>{if(contextDrag?.pointerId===event.pointerId)finishContextDrag(false);});
document.addEventListener('lostpointercapture',event=>{if(contextDrag?.pointerId===event.pointerId)finishContextDrag(false);});
window.addEventListener('blur',()=>finishContextDrag(false));
document.addEventListener('keydown',event=>{
 if(contextDrag&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finishContextDrag(false);return;}
 const marker=event.target.closest('[data-context-drag]');
 if(!marker||marker.disabled||contextDrag)return;
 const direction={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1}[event.key];
 if(!direction)return;
 event.preventDefault();event.stopImmediatePropagation();clearContextBoundaryError();
 const {waterline,replace}=contextBoundaries(),prepare=marker.dataset.contextDrag==='prepare';
 const step=event.shiftKey?0.1:1;
 const value=Number(((prepare?waterline*100:replace)+direction*step).toFixed(6));
 if(value<=0||(prepare?value>=100:value>100))return;
 mark(prepare?'压缩准备水位':'上下文预留',prepare?value/100:100-value);updateContextScale();
});
function updateSpecificPreviews(){
 const set=(key,text)=>{const n=$('[data-model-preview="'+key+'"]');if(n)n.textContent=text;};
 if(state.page==='models'&&state.detail==='model'){
  set('name',val('模型显示名称',state.modelName));set('context',Number(val('上下文容量',128000)).toLocaleString());set('output',Number(val('最大输出',8192)).toLocaleString());
  set('capabilities',[val('图片输入',true)?'图片输入':'',val('支持思考',true)?'支持思考':''].filter(Boolean).join(' · ')||'基础能力');
 }
 if(state.page==='editor'||state.page==='terminal'){
  const pre=$('.preview pre');if(pre){pre.style.fontSize=val(state.page==='editor'?'编辑字号':'终端字号',13)+'px';pre.style.fontFamily=val('等宽字体','Cascadia Code')+',Consolas,monospace';pre.style.whiteSpace=val('编辑器换行',true)?'pre-wrap':'pre';}
 }
}
function cleanupPreview(){
 dialog('清理预览',`<p>Local · 全部数据。根据对象引用与占用情况决定实际可释放内容。</p><div style="margin-top:20px" id="cleanup-items">${[['已失去引用的恢复对象','预计 820 MiB','保留仍被引用或正在使用的对象。'],['可释放的暂存内容','预计 340 MiB','不包含会话正文、源码或仍在使用的文件。']].map(([n,s,d])=>`<label class="cleanup-item"><input type="checkbox" checked data-cleanup><div><p>${n}</p><small>${d}</small></div><span class="small">${s}</span></label>`).join('')}</div><p class="hint">预计释放量是预览值；执行后按实际结果呈现。</p>`,[{text:'取消',action:'modal-close'},{text:'清理所选内容',action:'cleanup-run',primary:true}]);
}
function permissionEditor(index=-1){
 const rule=permissionRules()[index]||{tool:'',decision:'询问',param:'',pattern:''};
 dialog(index<0?'添加权限规则':'编辑权限规则',modalInput('工具注册名',rule.tool,'text','tool')+`<div class="field"><label>决定</label><select data-local="decision">${['允许','询问','拒绝'].map(d=>'<option '+(rule.decision===d?'selected':'')+'>'+d+'</option>').join('')}</select></div><details class="disclosure" ${rule.param?'open':''}><summary>${icon('arrow')}限制参数范围</summary><div>${modalInput('参数名',rule.param,'text','param')}${modalInput('匹配表达式',rule.pattern,'text','pattern')}</div></details><p class="hint">参数范围留空时匹配工具的全部参数。项目约束仍优先。</p><p id="rule-error" role="alert" class="error-inline"></p>`,[{text:'取消',action:'modal-close'},{text:'应用到草稿',action:'modal-commit',primary:true}]);
 commitDialog(()=>{
  const get=k=>$('[data-local='+k+']').value.trim(),rule={tool:get('tool'),decision:get('decision'),param:get('param'),pattern:get('pattern')};
  if(!rule.tool||Boolean(rule.param)!==Boolean(rule.pattern)){$('#rule-error').textContent='填写工具名；限制参数时，请同时填写参数名和匹配表达式。';return false;}
  const rules=[...permissionRules()];if(index<0)rules.push(rule);else rules[index]=rule;
  mark('权限规则',rules);render(true);
 });
}

function retryEditor(){
 simpleEditor('编辑重试规则',`<div class="field-pair"><div class="field"><label>匹配字段</label><select data-local="field"><option>状态码</option><option>错误代码</option><option>错误消息</option></select></div><div class="field"><label>匹配方式</label><select data-local="match"><option>精确</option><option>包含</option><option>正则表达式</option></select></div></div>${modalInput('匹配内容','503')}<div class="field"><label>匹配后的动作</label><select><option>重试</option><option>停止重试</option></select></div><p class="hint">规则按顺序匹配，保留原有 field、match、pattern、action。</p>`,()=>toast('示例：规则已修改，使用“保存重试设置”提交这一组'));
}
const actions = {
 theme(){state.theme=state.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=state.theme;},
 guide(){go('guide');},
 nav(){$('#stage').classList.toggle('nav-open');},
 close(){dialog('设置设计稿','<p>你可以继续切换页面和交互。正式产品中的关闭按钮沿用原设置窗口行为。</p>');},
 back(){if(state.page==='models'&&state.detail==='model'){state.detail='service';render();}else requestObjectChange(()=>{state.detail='';state.selected='';render();});},
 host(){dialog('选择示例主机','<p>只切换设计场景，不改变实际工作连接。</p><div class="object-list">'+objectRow('Local','此电脑','host-local','monitor')+objectRow('Workspace Host','远端主机示例','host-remote','cloud')+'</div>');},
 'host-local'(){closeModal();requestObjectChange(()=>{state.host='Local';state.offline=false;render();});},
 'host-remote'(){closeModal();requestObjectChange(()=>{state.host='Workspace Host';state.offline=false;render();});},
 reconnect(){state.offline=false;render(true);toast('示例：已恢复观察');},
 'modal-close':closeModal,
 'modal-commit'(){const callback=savedModalCallback;if(callback?.()===false)return;closeModal();},
 save(){save();},discard,
 'nav-discard'(){const next=pendingNavigation;closeModal();discard();pendingNavigation=undefined;next?.();},
 'nav-save'(){const next=pendingNavigation;closeModal();save(()=>{pendingNavigation=undefined;next?.();});},
 'model-add'(){state.detail='add';render();},
 'catalog-refresh'(){toast('示例：刷新模型目录，不发起连接健康检测');},
 credential(){simpleEditor('更换凭据',modalInput('新的 API Key','','password')+'<p class="hint">保存后由凭据服务保管引用；已有密钥不回显。</p>',()=>{state.drafts.add(owner());renderFooter();toast('示例：新凭据已填入当前服务草稿');});},
 'model-catalog'(){simpleEditor('从目录添加模型','<p class="hint">只把所选模型加入当前服务草稿。</p><label class="cleanup-item"><input type="checkbox" checked><div>示例对话模型</div></label><label class="cleanup-item"><input type="checkbox"><div>示例嵌入模型</div></label>',()=>{state.drafts.add(owner());renderFooter();toast('示例：所选模型已加入草稿');});},
 'model-manual'(){simpleEditor('添加模型',modalInput('模型 ID','','text','modelId')+modalInput('显示名称','','text','name'),()=>{const id=$('[data-local=modelId]').value.trim(), name=$('[data-local=name]').value.trim()||id;if(!id)return false;editServiceModels([...serviceModels(),name]);toast('模型已加入当前服务草稿');});},
 'test-model'(){const target=$('#test-result');target.innerHTML='<div class="note">正在演示一次测试请求…</div>';setTimeout(()=>{if(target.isConnected)target.innerHTML='<div class="note"><strong>本次测试完成 · 示例</strong><br>620 ms<br>OK<br><span class="faint">这次观察不会改成持续在线状态。</span></div>';},500);},
 'restore-model'(){state.drafts.add(owner());renderFooter();toast('示例：恢复目录值，随服务一起保存');},
 'remove-model'(){dialog('移除这个模型？','<p>先从当前服务草稿移除，保存服务后生效。</p>',[{text:'取消',action:'modal-close'},{text:'移除',action:'model-remove-confirm',danger:true}]);},
 'model-remove-confirm'(){const models=serviceModels().filter(n=>n!==state.modelName);closeModal();state.detail='service';editServiceModels(models);toast('模型已从草稿移除');},
 'remove-service'(){dialog('移除服务？','<p>此服务及其模型配置会被移除。相关模型用途需要重新选择。</p>',[{text:'取消',action:'modal-close'},{text:'移除服务',action:'service-remove-confirm',danger:true}]);},
 'service-remove-confirm'(){closeModal();state.drafts.delete(owner());state.detail='';state.selected='';render();toast('示例：服务移除流程结束');},
 'global-scope'(){mark('范围','主机默认',false);render(true);},
 'inherit-defaults'(){toast('示例：移除项目覆盖，恢复主机默认');},
 'edit-retry':retryEditor,
 'retry-sample'(){dialog('用错误样例检查规则',modalInput('状态码','503')+modalInput('错误代码','')+'<div class="field"><label>错误消息</label><textarea data-local="message">temporarily unavailable</textarea></div><div id="retry-result"></div>',[{text:'完成',action:'modal-close'},{text:'检查匹配',action:'retry-check',primary:true}]);},
 'retry-check'(){$('#retry-result').innerHTML='<div class="note">示例结果：匹配第 1 条规则 → 重试。正式实现调用现有规则检查接口。</div>';},
 'storage-refresh'(){toast('示例：重新读取当前设备与范围的统计');},
 'storage-project'(){mark('存储范围','项目 · opencr',false);render(true);},
 'cleanup-preview':cleanupPreview,
 'cleanup-run'(){const items=document.querySelectorAll('[data-cleanup]');if(items.length&&!document.querySelectorAll('[data-cleanup]:checked').length)return toast('请至少选择一类内容');dialog('清理结果 · 示例','<div class="storage-total" style="margin-top:24px"><strong>820</strong><span>MiB · 实际已释放</span></div><div class="note warn">部分对象仍被占用，已保留。可重试项使用原清理身份继续处理。</div><p class="hint">预览值与实际释放量分开显示，不将逻辑删除当成空间回收。</p>',[{text:'完成',action:'modal-close'},{text:'查看未完成项',action:'cleanup-details'}]);},
 'cleanup-details'(){dialog('未完成的对象','<div class="resource-line">'+icon('clock')+'<div><p>暂存内容仍在使用</p><small>占用解除后，沿原 owner 提供的重试入口回收。</small></div></div>',[{text:'返回结果',action:'cleanup-run'},{text:'完成',action:'modal-close'}]);},
 'copy-info'(){dialog('工作副本的回收','<p>正在使用、仍被任务引用或待发布的工作副本继续保留。正式页面显示原生命周期的原因和可用操作。</p>');},
 'edit-permission'(){permissionEditor();},
 'permission-project'(){dialog('项目权限约束','<p>opencr 的 ask / deny 规则优先于用户允许规则。没有项目放行规则覆盖这一约束。</p><div class="note">此处是规则来源查看；修改时沿原配置 owner 保存。</div>');},
 'execution-options'(){dialog('Shell 与输出',row('Shell',select('工具Shell',['自动','PowerShell','Git Bash','WSL']))+row('等待时间',numbered('10','s','工具等待'))+row('可见输出',numbered('64','KiB','工具输出'))+'<p class="hint">落地时逐项接到当前执行器支持的配置。</p>');},
 'memory-add'(){simpleEditor('添加记忆','<p class="hint">'+esc(val('记忆范围','全局'))+'</p><div class="field"><label>内容</label><textarea data-local="memory" rows="5"></textarea></div>',()=>{const text=$('[data-local=memory]').value.trim();if(!text)return false;currentNotes().push({id:nextNoteId++,text,source:'手动记录'});render(true);toast('记忆已添加到当前范围');});},
 'memory-save'(){state.noteEdit=null;state.drafts.delete(owner());delete state.restored[owner()];render(true);toast('示例：这条记忆已保存');},
 'memory-cancel'(){state.noteEdit=null;discard();},
 'avatar'(){dialog('选择头像','<div class="actions" style="gap:18px;padding:22px 0">'+['◕','◡','◔','◒','◉','◠'].map((x,i)=>'<button class="avatar '+(i%2?'warm':'blue')+'" data-action="avatar-pick" aria-label="选择头像 '+(i+1)+'">'+x+'</button>').join('')+'</div><p class="hint">正式实现继续使用已有头像库。</p>');},
 'avatar-pick'(){closeModal();state.drafts.add(owner());renderFooter();toast('示例：头像选择已加入草稿');},
 'agent-add'(){simpleEditor('新建 Agent',modalInput('名称','新 Agent')+modalInput('用途说明',''),()=>toast('示例：进入新 Agent 的完整编辑页'));},
 'agent-tools'(){simpleEditor('选择工具',`<p class="hint">工具来自实际注册目录。空选择、继承和显式选择保留各自含义。</p>${['file_read','file_search','file_write','process_spawn','ask_user'].map((n,i)=>`<label class="cleanup-item"><input type="checkbox" ${i<2?'checked':''}><code>${n}</code></label>`).join('')}`,()=>{state.drafts.add(owner());renderFooter();});},
 'bot-add'(){simpleEditor('新建 Bot',modalInput('名称','项目助手')+'<div class="field"><label>指令</label><textarea></textarea></div>');},
 'bot-work'(){dialog('Bot 工作线程','<p>正式实现沿原 Thread 身份打开工作线程，并保留返回设置的位置。</p>'+objectRow('检查项目文档','等待后续任务','modal-close','chat'));},
 'local-models'(){dialog('本地模型文件','<div class="resource-line">'+icon('database')+'<div><p>当前嵌入模型</p><small>已下载 · 示例状态；正式名称和大小来自目录</small></div>'+btn('删除文件','model-file-delete','danger ghost')+'</div><div class="resource-line">'+icon('database')+'<div><p>可用模型</p><small>支持下载、进度、取消和重试</small></div>'+btn('下载','model-file-download')+'</div>');},
 'local-refresh'(){toast('示例：刷新本地模型状态');},
 'model-file-download'(){toast('示例：显示原模型下载进度，不新增下载任务');},
 'model-file-delete'(){dialog('删除本地模型文件？','<p>删除后再次使用需要重新下载。共享占用由模型 owner 判断。</p>',[{text:'取消',action:'modal-close'},{text:'删除示例文件',action:'modal-close',danger:true}]);},
 'test-notification'(){toast('通知预览：需要你的回答');},
 'voice-preview'(){toast('试听入口演示；此设计稿不发起语音请求');},
 'speech-models'(){actions['local-models']();},
 'reset-shortcuts'(){dialog('恢复默认快捷键？','<p>正式页面会移除自定义键位覆盖。</p>',[{text:'取消',action:'modal-close'},{text:'恢复默认',action:'modal-close',primary:true}]);},
 'reset-shortcut'(){toast('示例：已恢复该动作的默认键位');},
 'history-cleanup'(){dialog('会话清理范围','<p>先列出符合保留策略的会话及关联资源，再提交原清理操作。</p><div class="note">共享引用、仍在使用和部分失败都保留明确回执。</div>',[{text:'关闭',action:'modal-close'},{text:'查看存储',action:'modal-storage'}]);},
 'modal-storage'(){closeModal();go('storage');},
 'folder-picker'(){simpleEditor('选择目录',modalInput('目录路径','D:\\project\\opencr'),()=>toast('示例：目录已选入当前编辑单元'));},
 'recovery-move'(){dialog('迁移恢复位置','<p>来源、目标、正在使用的对象和迁移结果在同一流程中说明。</p><div class="note">当前目录 → D:\\VarinData\\recovery<br>真实迁移由原恢复 owner 执行。</div>',[{text:'取消',action:'modal-close'},{text:'查看示例结果',action:'recovery-result',primary:true}]);},
 'recovery-result'(){dialog('迁移结果 · 示例','<p>已完成的对象与仍待处理的对象分开列出，失败时保留原位置。</p>');},
 'recovery-workspace'(){simpleEditor('opencr · 恢复设置',row('位置',select('项目恢复位置',['继承全局','项目自定义']))+row('保留期',select('项目恢复期',['继承全局','单独设置'])));},
 'project-add'(){simpleEditor('添加项目',modalInput('名称','新项目')+modalInput('目录','D:\\work\\project'));},
 'project-icon'(){actions.avatar();},
 'color-pick'(){toast('示例：项目强调色已更新');},
 'remove-folder'(){dialog('移除项目目录？','<p>移除项目关联，不删除磁盘文件。</p>',[{text:'取消',action:'modal-close'},{text:'移除关联',action:'modal-close',danger:true}]);},
 'project-action'(){simpleEditor('项目启动动作',modalInput('名称','打开项目文档')+`<div class="field"><label>类型</label><select><option>打开 URL</option><option>SSH 转发</option><option>运行命令</option></select></div>`+modalInput('目标','https://docs.example.test'));},
 'github-connect'(){dialog('连接 GitHub','<p>授权入口沿现有账号服务进行。设计稿不启动真实授权。</p>',[{text:'返回',action:'modal-close'},{text:'查看授权结果',action:'github-result',primary:true}]);},
 'github-result'(){dialog('GitHub 账号 · 示例','<p>授权完成后显示账号标识与断开入口，提交身份仍在下方独立管理。</p>');},
 'git-identity'(){simpleEditor('提交身份',modalInput('显示名称','个人')+modalInput('Git 用户名','You')+modalInput('Git 邮箱','you@example.test','email'));},
 'git-import'(){dialog('导入发现的身份','<p>正式页面列出实际发现的 Git 身份，用户选择后导入。</p>');},
 'language-refresh'(){toast('示例：刷新当前工作区的支持状态');},
 'language-detail'(){dialog('语言支持包','<p>保留支持来源、结构提取结果与失败回退说明。</p><div class="resource-line"><div><p>结构提取 · Tree-sitter</p><small>解析失败时沿当前文本回退能力读取。</small></div></div><div class="actions">'+btn('准备支持包','language-prepare')+btn('移除','language-remove','danger ghost')+'</div>');},
 'language-prepare'(){toast('示例：准备、取消与重试沿原支持包操作');},
 'language-remove'(){toast('示例：展示支持包移除影响');},
 'language-import'(){simpleEditor('导入语言支持包',modalInput('支持包路径',''));},
 'language-service'(){dialog('编辑器语言服务','<p>查看此工作区的实际服务状态、日志与可用操作。它与 Agent 的工具目录分开管理。</p>');},
 'computer-refresh'(){toast('示例：刷新桌面服务快照');},
 'desktop-detail'(){dialog('桌面详情','<p>保留原桌面身份、所属主机和实际运行状态。</p>'+row('默认目标',toggle('设为默认桌面',false))+btn('打开桌面','desktop-open'));},
 'desktop-open'(){toast('设计稿保留当前页面；正式产品导航到原桌面');},
 'resource-detail'(){dialog('会话资源来源','<p>来源在会话中明确选择。这里查看身份与可用性，不自动替换当前会话的来源。</p>');},
 'remote-add'(){dialog('添加连接','<div class="object-list">'+objectRow('通过 SSH','使用现有 SSH 实例编辑流程。','ssh-detail','terminal')+objectRow('直接连接 Host','填写地址，或导入配对链接。','direct-host','cloud')+'</div>');},
 'ssh-detail'(){closeModal();state.detail='ssh';render();},
 'connect-instance'(){toast('示例：连接中 → 按实际回执更新状态');},
 'connection-log'(){dialog('连接日志 · 示例','<pre>Preparing SSH connection…\nWaiting for the original Host handshake.</pre><p class="hint">真实页面显示原连接日志，不伪造成功。</p>');},
 'remove-instance'(){dialog('移除实例配置？','<p>断开连接、移除配置和远端数据保留分别说明。</p>',[{text:'取消',action:'modal-close'},{text:'移除配置',action:'modal-close',danger:true}]);},
 'direct-host'(){simpleEditor('直接连接 Host',modalInput('名称','Workspace Host')+modalInput('Host URL','https://host.example.test','url')+modalInput('API URL','','url')+modalInput('访问 Token','','password')+fold('请求头','可选','<textarea aria-label="请求头">{}</textarea>'));},
 'pairing-import'(){simpleEditor('导入配对链接',modalInput('链接','','url'));},
 'port-forward'(){simpleEditor('端口转发',modalInput('本地端口','8080','number')+modalInput('远端端口','8080','number'));},
 'pair-device'(){dialog('配对设备','<p>选择连接方式，再生成有效的设备配对入口。</p><div class="field"><label>连接方式</label><select><option>中继</option><option>局域网</option><option>本地</option></select></div><div class="note">正式页面在创建成功后显示二维码与链接。此稿不生成可用凭据或仿造二维码。</div>',[{text:'取消',action:'modal-close'},{text:'查看配对结果','action':'pair-result',primary:true}]);},
 'pair-result'(){dialog('等待设备配对 · 示例','<p>入口的有效期、连接方式和取消操作会保留在这里。设备完成配对后进入设备列表。</p>',[{text:'取消配对',action:'modal-close'},{text:'完成',action:'modal-close',primary:true}]);},
 'device-detail'(){dialog('设备访问记录','<p>原设备身份、平台、最近使用和访问方式可在此查看。</p><div class="note">“最近使用”对应请求活跃记录。</div>');},
 'revoke-device'(){dialog('撤销此设备访问？','<p>撤销后该设备需要重新配对；不会删除原会话或工作区文件。</p>',[{text:'取消',action:'modal-close'},{text:'撤销访问',action:'modal-close',danger:true}]);},
 'cancel-pairing'(){toast('示例：取消原待完成配对');},
 'access-password'(){simpleEditor('更改访问密码',modalInput('新密码','','password'));},
 'tunnel-start'(){mark('隧道运行',true,false);render(true);toast('隧道运行场景 · 示例');},
 'tunnel-stop'(){mark('隧道运行',false,false);render(true);},
 'tunnel-info'(){dialog('连接信息 · 示例','<p>https://demo.example.test</p><div class="note">引导有效期、会话有效期及真实二维码由隧道服务返回。</div>');},
 'mcp-add'(){simpleEditor('添加 MCP 服务',modalInput('名称','New server')+modalInput('URL 或命令','https://mcp.example.test'),()=>{state.tabs.mcp='config';state.drafts.add(owner());render();});},
 'mcp-auth'(){dialog('授权 MCP 服务','<p>服务需要登录。保留授权回调、取消和失败重试入口。</p>',[{text:'取消',action:'modal-close'},{text:'完成示例授权',action:'mcp-authorized',primary:true}]);},
 'mcp-authorized'(){closeModal();toast('示例授权已完成；工具连接结果仍由服务确认');},
 'mcp-connect'(){toast('示例：正在重新连接原服务');},
 'mcp-disconnect'(){toast('示例：断开当前服务连接');},
 'skill-add'(){simpleEditor('新建 Skill',modalInput('名称','new-skill')+'<div class="field"><label>范围</label><select><option>用户</option><option>项目 · opencr</option></select></div>');},
 'resource-source'(){dialog('资源来源','<p>保留原文件路径、scope、origin、可写状态和目录诊断。</p><pre>skills/code-review/SKILL.md\n来源：用户资源\n状态：有效 · 可编辑</pre>');},
 'resource-copy'(){simpleEditor('复制资源到…','<div class="field"><label>目标范围</label><select><option>用户资源</option><option>项目 · opencr</option></select></div>'+modalInput('名称',state.selected||'code-review'));},
 'resource-refresh'(){toast('示例：刷新原资源目录');},
 'resource-delete'(){dialog('删除此 Skill？','<p>删除原可写资源后，对应命令将不再由目录提供。</p>',[{text:'取消',action:'modal-close'},{text:'删除',action:'modal-close',danger:true}]);},
 'extension-install'(){simpleEditor('安装扩展',modalInput('包或目录','')+'<div class="field"><label>来源</label><select><option>包标识</option><option>本地目录</option></select></div><p class="hint">候选准备完成后进入原能力审阅流程。</p>',()=>toast('示例：候选已准备，进入能力审阅'));},
 'extension-review'(){dialog('审阅扩展候选','<p>Example integration · 新候选</p><div class="resource-line">'+icon('globe')+'<div><p>网络能力</p><small>按候选声明与完整性身份展示。</small></div></div><div class="resource-line">'+icon('folder')+'<div><p>资源访问能力</p><small>允许 / 拒绝针对本次候选。</small></div></div><details class="disclosure"><summary>'+icon('arrow')+'来源与完整性</summary><div><code>本地扩展目录 · 示例</code></div></details>',[{text:'拒绝',action:'modal-close'},{text:'允许并应用候选',action:'extension-approved',primary:true}]);},
 'extension-approved'(){closeModal();toast('示例：候选受理后继续显示实际应用状态');},
 'service-directory'(){dialog('已声明服务','<p>保留真实服务名称、当前提供方、选择来源与不可用原因。</p>');},
 'profile-detail'(){simpleEditor('工作台配置',row('Shell',select('ProfileShell',['Agent Workspace','IDE Workspace','Research Workspace']))+modalInput('配置名称','Agent Workspace'));},
 'profile-apply'(){dialog('应用扩展集？','<p>正式流程将列出实际启用与停用变化，再交给原工作台 owner 应用。</p>',[{text:'取消',action:'modal-close'},{text:'应用示例配置',action:'modal-close',primary:true}]);},
 'profile-new'(){simpleEditor('新建工作台配置',modalInput('名称','My workspace'));},
 'profile-delete'(){dialog('移除工作台配置？','<p>移除配置与卸载扩展分别处理。</p>',[{text:'取消',action:'modal-close'},{text:'移除',action:'modal-close',danger:true}]);},
 'app-update'(){toast('设计稿不检查真实更新；正式界面使用当前应用更新来源');},
 'copy-diagnostics'(){toast('设计稿不会读取或复制真实设备诊断');},
 'project-site'(){dialog('项目链接','<p>项目主页与发布记录沿现有入口打开。</p>');},
 licenses(){dialog('开源许可','<p>正式界面保留 LICENSE 和 THIRD_PARTY_NOTICES，并能阅读完整声明。</p>');}
};

function handle(action){
 if(actions[action])return actions[action]();
 const [kind,...tail]=action.split(':'), value=tail.join(':');
 if(kind==='goto')return go(value);
 if(kind==='speech-download')return toast('下载流程示意：正式界面在当前模型卡片显示进度、取消和失败重试。');
 if(kind==='permission-edit')return permissionEditor(Number(value));
 if(['permission-up','permission-down','permission-delete'].includes(kind)){
  const rules=[...permissionRules()],i=Number(value);
  if(kind==='permission-delete')rules.splice(i,1);else{const j=i+(kind==='permission-up'?-1:1);[rules[i],rules[j]]=[rules[j],rules[i]];}
  mark('权限规则',rules);return render(true);
 }
 if(kind==='service')return requestObjectChange(()=>{state.selected=value;state.detail='service';state.tabs.service='models';render();});
 if(kind==='model'){state.modelName=value;state.detail='model';return render();}
 if(kind==='agent-select'||kind==='bot-select'||kind==='project'||kind==='mcp-select'||kind==='skill')return requestObjectChange(()=>{state.selected=value;render();});
 if(kind==='skill-route'){return requestObjectChange(()=>{go('skills',true);state.selected=value;render();});}
 if(kind==='memory-edit')return requestObjectChange(()=>{state.noteEdit=Number(value);render(true);});
 if(kind==='memory-delete'){dialog('删除这条记忆？','<p>来源会话仍保留。之后将不再引用这条记忆。</p>',[{text:'取消',action:'modal-close'},{text:'删除',action:'modal-commit',danger:true}]);return commitDialog(()=>{const items=currentNotes(),i=items.findIndex(n=>n.id===Number(value));if(i>=0)items.splice(i,1);render(true);});}
 if(kind==='save-section')return toast('示例：仅保存当前设置单元');
 if(kind==='tool-family'){
 const families={'文件与代码':['file_read','file_list','file_search','file_write','file_edit','file_restore'],'终端与进程':['process_spawn','process_read','process_write','process_inspect','process_resize'],'网页与文档':['websearch','webfetch','document_read'],'扩展与 MCP':['mcp__docs__search','mcp__docs__read_page']};
 return dialog(value,`<div class="object-list">${families[value].map(n=>objectRow(n,value==='扩展与 MCP'?'Documentation · MCP 服务':value==='网页与文档'?'内置扩展':'原生工具','modal-close','code')).join('')}</div><p class="hint">在 Agent 配置中选择工具；允许、询问与拒绝由权限规则管理。</p>`);
 }
 if(kind==='extension-detail')return dialog(value,`<p>已安装扩展 · 示例</p>${fold('贡献与服务','查看', '<p class="hint">Shell、贡献点、服务、依赖与原能力授予。</p>',true)}${fold('来源与诊断','查看','<p class="hint">保留 source / version / integrity / realms / diagnostics。</p>')}<div class="actions">${btn('重新加载本地来源','resource-refresh')}${btn('移除','resource-delete','danger ghost')}</div>`);
 if(kind==='record-shortcut'){
  dialog('录入快捷键',`<p>${esc(value)}</p><div id="key-capture" style="padding:30px 0;font-size:23px;text-align:center">按下新的组合键</div><p class="hint">Esc 取消。冲突会列出占用动作。</p>`,[{text:'取消',action:'modal-close'},{text:'使用此组合','action':'shortcut-use',primary:true}]);
  keyRecorder=value;return;
 }
 if(action==='shortcut-use'){closeModal();return toast('示例：快捷键已更新');}
 if(kind==='scenario'){
  if(value==='save'){go('models',true);state.selected='deepseek';state.detail='service';state.tabs.service='connection';state.drafts.add(owner());state.failNext=true;render();return toast('修改任意字段后保存，可查看失败与重试状态');}
  if(value==='offline'){state.offline=true;return go('connections',true);}
  if(value==='cleanup'){go('storage',true);return cleanupPreview();}
  if(value==='shortcut'){go('shortcuts',true);return dialog('这个快捷键已被使用','<p><kbd>Ctrl K</kbd> 当前用于“搜索会话”。</p><div class="note">覆盖后，原动作将失去这一快捷键。</div>',[{text:'重新录入',action:'record-shortcut:新建会话'},{text:'取消',action:'modal-close'},{text:'覆盖',action:'shortcut-use',primary:true}]);}
  if(value==='mcp'){go('mcp',true);state.selected='Design tools';state.tabs.mcp='diagnostics';return render();}
 }
 toast('此操作沿对应对象的原有入口执行 · 设计示例');
}

document.addEventListener('click',event=>{
 const target=event.target.closest('button,[data-go]');
 if(!target||target.disabled)return;
 if(target.dataset.go)return go(target.dataset.go);
 if(target.dataset.review){state.device=target.dataset.review;$('#stage').classList.remove('narrow','phone');if(state.device!=='desktop')$('#stage').classList.add(state.device);document.querySelectorAll('[data-review]').forEach(b=>b.classList.toggle('active',b.dataset.review===state.device));return;}
 if(target.dataset.group){const i=Number(target.dataset.group);state.navClosed.has(i)?state.navClosed.delete(i):state.navClosed.add(i);return renderNav();}
 if(target.dataset.tab){state.tabs[target.dataset.tabGroup||'tab']=target.dataset.tab;return render(true);}
 if(target.dataset.scene){state.scene=target.dataset.scene;return render(true);}
 if(target.dataset.choice!==undefined){
  mark(target.dataset.key,target.dataset.choice,target.dataset.key!=='权限模式');
  if(target.dataset.key==='chat-mode')state.mode=target.dataset.choice;
  if(target.dataset.key==='color-mode'){state.theme=target.dataset.choice==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):target.dataset.choice;document.documentElement.dataset.theme=state.theme;}
  return render(true);
 }
 if(target.dataset.anchor){$('#'+target.dataset.anchor)?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});return;}
 if(target.dataset.action)handle(target.dataset.action);
});
document.addEventListener('input',event=>{
 const t=event.target;
 if(t.id==='search')return renderNav();
 if(t.hasAttribute('data-list-filter')){
  const q=t.value.toLowerCase();$('#page').querySelectorAll('[data-filter-text]').forEach(row=>row.hidden=!row.dataset.filterText.toLowerCase().includes(q));return;
 }
 if(t.dataset.local||t.closest('.dialog'))return;
 if(!t.dataset.key)return;
 if(t.type==='checkbox'||t.tagName==='SELECT')return;
 mark(t.dataset.key,t.value);previewStyle();updateSpecificPreviews();
});
document.addEventListener('change',event=>{
 const t=event.target;
 if(t.dataset.contextThreshold)return changeContextBoundary(t);
 if(t.dataset.local||t.closest('.dialog')||!t.dataset.key)return;
 if(t.type!=='checkbox'&&t.tagName!=='SELECT')return;
 mark(t.dataset.key,t.type==='checkbox'?t.checked:t.value);
 const contextual=['后台准备','朗读启用','听写启用','识别提供方','用途-对话','用途-快速决策','用途-图像生成','用途-图像编辑','决策预设','图像预设','thinking','展开思考','展开命令','展开编辑','搜索提供商','域名白名单','范围','自动清理会话','下一步辅助','隧道模式','MCP配置来源','记忆范围','Skill范围','项目恢复位置'];
 if(contextual.includes(t.dataset.key))render(true);else{previewStyle();updateSpecificPreviews();}
});
$('#search').addEventListener('keydown',e=>{if(e.key==='Enter'){$('#nav .nav-link')?.click();}if(e.key==='Escape'){e.target.value='';renderNav();e.target.blur();}});
document.addEventListener('keydown',event=>{
 if(keyRecorder&&event.key!=='Escape'&&event.key!=='Tab'){
  event.preventDefault();const keys=[event.ctrlKey?'Ctrl':'',event.metaKey?'Meta':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',!['Control','Meta','Alt','Shift'].includes(event.key)?event.key.toUpperCase():''].filter(Boolean);
  $('#key-capture').textContent=keys.join(' + ');return;
 }
 if(event.key==='Escape'&&$('.dialog')){event.preventDefault();closeModal();return;}
 if(event.key==='Tab'&&$('.dialog')){
  const nodes=[...$('.dialog').querySelectorAll('button,input,select,textarea,a')].filter(n=>!n.disabled&&n.getClientRects().length);
  const first=nodes[0],last=nodes.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
 }
 if((event.ctrlKey||event.metaKey)&&event.key==='k'){event.preventDefault();$('#search').focus();}
 if((event.ctrlKey||event.metaKey)&&event.key==='s'&&state.drafts.has(owner())){event.preventDefault();save();}
});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(pages[next]&&next!==state.page)go(next);});
if(pages[location.hash.slice(1)])state.page=location.hash.slice(1);
render();
