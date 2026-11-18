/* Varin · 设置设计稿 · 示例数据（全部虚构，不对应任何真实账户或机器） */
window.DATA = {
  /* 导航：按「用户要管的东西」分组。每个旧入口都有去处，见 README 的对照表。 */
  nav: [
    { g: '偏好', items: ['general', 'appearance', 'chat', 'notifications', 'voice', 'shortcuts', 'companion'] },
    { g: '模型', items: ['models', 'model-roles', 'usage'] },
    { g: 'Agent', items: ['varin', 'agents', 'external-agents', 'instructions', 'memory', 'context'] },
    { g: '能力', items: ['tools', 'permissions', 'workspaces', 'desktops', 'browsers', 'web', 'mcp', 'skills', 'plugins'] },
    { g: '项目', items: ['projects', 'editor', 'terminal', 'git', 'code-intel'] },
    { g: '设备与网络', items: ['devices', 'remote-access', 'proxy'] },
    { g: '数据', items: ['storage', 'history', 'about'] },
  ],

  services: [
    { id: 'openai', name: 'OpenAI', logo: 'openai', kind: 'OpenAI', url: 'https://api.openai.com/v1', status: 'ok', models: [
      { id: 'gpt-6-astra', caps: ['对话', '图像输入', '推理'], desc: '复杂推理、编程和长任务。', ctx: '1M' },
      { id: 'gpt-6.1-sol', caps: ['对话', '图像输入', '推理'], desc: '接近 Astra 的能力，成本更低。', ctx: '512K' },
      { id: 'gpt-6-luna', caps: ['对话', '推理'], desc: '响应快，适合大量简单任务。', ctx: '256K' },
      { id: 'gpt-image-2.5', caps: ['图像生成', '图片编辑'], desc: '按提示生成和修改图片。' },
    ] },
    { id: 'anthropic', name: 'Anthropic', logo: 'anthropic', kind: 'Anthropic', url: 'https://api.anthropic.com', status: 'ok', models: [
      { id: 'claude-opus-5-5', caps: ['对话', '图像输入', '推理'], desc: '最强的规划与写作能力。', ctx: '1M' },
      { id: 'claude-sonnet-5-5', caps: ['对话', '图像输入', '推理'], desc: '日常编程和工作的主力。', ctx: '1M' },
      { id: 'claude-haiku-5-5', caps: ['对话', '快速决策'], desc: '快速、便宜，适合判断和辅助。', ctx: '256K' },
    ] },
    { id: 'deepseek', name: 'DeepSeek', logo: 'deepseek', kind: 'OpenAI 兼容', url: 'https://api.deepseek.com/v1', status: 'ok', models: [
      { id: 'deepseek-v4.1-flash', caps: ['对话', '推理'], desc: '速度快，价格低。', ctx: '256K' },
      { id: 'deepseek-v4.1-pro', caps: ['对话', '推理'], desc: '更深入的推理。', ctx: '256K' },
    ] },
    { id: 'openrouter', name: 'OpenRouter', logo: 'openrouter', kind: 'OpenAI 兼容', url: 'https://openrouter.ai/api/v1', status: 'ok', models: [
      { id: 'deepseek-v4.1-flash', caps: ['对话', '推理'], desc: '通过 OpenRouter 接入的 DeepSeek 模型。', ctx: '256K' },
      { id: 'qwen3-embedding-0.6b', caps: ['嵌入'], desc: '多语言向量化。' },
      { id: 'qwen3-reranker-8b', caps: ['重排'], desc: '检索结果重排序。' },
      { id: 'jev-1.14', caps: ['快速决策'], desc: '低延迟的是 / 否判断。' },
    ] },
    { id: 'ollama', name: '本地 Ollama', logo: 'ollama', kind: 'Ollama', url: 'http://127.0.0.1:11434', status: 'err', models: [
      { id: 'qwen3:8b', caps: ['对话'], desc: '离线可用的小模型。', ctx: '32K' },
    ] },
  ],

  /* 模型分工与功能页共用这组模型选择 */
  roles: {
    default: { l: '默认模型', d: '新对话一开始使用；对话里可以随时换。', def: 'claude-sonnet-5-5', think: '高' },
    assist: { l: '辅助模型', d: '起标题、写提交说明这类简短的工作。', def: 'deepseek-v4.1-flash', think: '低' },
    decide: { l: '快速判断', d: '判断搜索结果、论文和记忆值不值得用，需要响应快。', def: 'jev-1.14' },
    plan: { l: '执行循环的规划', d: '插件提供的执行循环要求先规划时才用。不指定就不规划，也不会改用默认模型。', def: '', think: '高' },
    permJudge: { l: '权限判断', d: '判断一次工具调用能不能直接执行；拿不准时照常问你。', def: 'claude-haiku-5-5' },
    retrieval: { l: '代码检索', d: '查代码时判断哪些结果相关，并决定是否继续找。', def: 'deepseek-v4.1-flash', think: '中' },
    searchPick: { l: '选择搜索服务', d: '配置了多个搜索服务时，挑出最适合这次问题的那个。', def: 'jev-1.14', toggle: true },
    readPick: { l: '挑选原文段落', d: '读网页时按问题挑出相关段落，失败时照常整页阅读。', def: 'jev-1.14', toggle: true },
    dispatch: { l: '派发时选模型', d: '派发任务时，按各模型的简介挑一个合适的。', def: 'claude-haiku-5-5', toggle: true },
    next: { l: '下一步建议', d: '每轮结束后起草一句你可能想说的话，按 Tab 采用。', def: 'deepseek-v4.1-flash', think: '默认', toggle: true, off: true },
    imageGen: { l: '生成图片', d: '不指定时，Agent 没有生成图片的工具。', def: 'gpt-image-2.5', cap: '图像生成' },
    imageEdit: { l: '修改图片', d: '不指定时，Agent 没有修改图片的工具。', def: '', cap: '图片编辑' },
    embed: { l: '向量化', d: '记忆和 Bot 知识的语义检索。不指定时使用文本检索。', def: 'qwen3-embedding-0.6b', cap: '嵌入' },
    rerank: { l: '重排', d: '把代码检索的候选结果按相关程度重新排序。', def: 'qwen3-reranker-8b', cap: '重排' },
  },

  agents: [
    { id: 'worker', name: 'Worker', color: '#a78bdb', builtin: true, desc: '理解整体目标，自主推进委派的任务并交付可用成果。', model: '', think: '默认', focus: ['通用', '编程', '科研', '办公'] },
    { id: 'verify', name: '验证', color: '#8fb07a', builtin: true, desc: '独立检查改动和结论，指出证据不足的地方。', model: 'claude-sonnet-5-5', think: '高', focus: ['编程', '科研'] },
    { id: 'research', name: '调研', color: '#e3b58a', builtin: true, desc: '搜集资料、比较来源，整理成有出处的结论。', model: '', think: '中', focus: ['通用', '科研'] },
    { id: 'compact', name: '上下文整理', color: '#e07a6e', builtin: true, auto: true, desc: '对话太长时整理摘要，自动运行。', model: 'deepseek-v4.1-flash', think: '低', focus: ['通用', '编程', '科研', '办公'] },
    { id: 'writer', name: '文档撰写', color: '#7aa0d6', builtin: false, desc: '把讨论和结果写成面向读者的文档。', model: 'claude-opus-5-5', think: '中', focus: ['办公'] },
  ],

  bots: [
    { id: 'varin', name: 'Varin', group: '', state: '正在跟进 2 件事', main: true },
    { id: 'scholar', name: '研究助理', group: '工作', state: '空闲' },
    { id: 'chef', name: '家务管家', group: '生活', state: '休息中' },
  ],

  externalAgents: [
    { id: 'codex', name: 'Codex', logo: '../../../packages/ui/src/assets/harness-logos/codex.svg', ver: '0.98.1', state: 'ready', on: true },
    { id: 'claude', name: 'Claude Code', logo: '../../../packages/ui/src/assets/provider-logos/claude.svg', ver: '2.4.0', state: 'ready', on: false },
    { id: 'opencode', name: 'OpenCode', logo: '../../../packages/ui/src/assets/harness-logos/opencode.svg', ver: '1.18.9', state: 'ready', on: true },
    { id: 'pi', name: 'Pi', logo: '../../../packages/ui/src/assets/harness-logos/pi.svg', ver: '0.84.3', state: 'update', on: true },
  ],

  projects: [
    { id: 'launch-site', name: 'launch-site', path: '~/work/launch-site', trusted: true, color: '#4b6fac', folders: 1, dev: 'studio-pc' },
    { id: 'varin-docs', name: 'varin-docs', path: '~/work/varin-docs', trusted: false, color: '#5f8d3d', folders: 2, dev: 'studio-pc' },
    { id: 'thesis', name: '毕业论文', path: '~/Documents/thesis', trusted: true, color: '#b35017', folders: 1, dev: 'studio-pc' },
    { id: 'train', name: 'train-pipeline', path: '/srv/train-pipeline', trusted: true, color: '#7a5bb5', folders: 1, dev: 'gpu-box' },
  ],

  skills: [
    { id: 'release-notes', name: 'release-notes', src: '用户', desc: '把合并记录整理成面向用户的版本说明。', on: true },
    { id: 'paper-review', name: 'paper-review', src: '用户', desc: '按会议评审标准审读论文草稿并给出修改建议。', on: true },
    { id: 'figma-handoff', name: 'figma-handoff', src: '项目 · launch-site', desc: '读取设计稿标注，生成组件实现清单。', on: true },
    { id: 'data-clean', name: 'data-clean', src: '插件 · 数据工具', desc: '检查表格中的缺失值、重复和异常。', on: false },
  ],

  toolGroups: [
    ['文件', 'file_list file_read file_search file_write file_edit file_restore recovery_points'],
    ['命令与进程', 'process_spawn process_read process_write process_inspect process_resize process_stop wait_process script_open script_run script_close submit_code'],
    ['网络与研究', 'websearch webfetch research_search document_read materials'],
    ['浏览器', 'browser_open browser_tabs browser_read browser_act browser_files browser_resources'],
    ['电脑操作', 'computer_list computer_observe computer_act computer_query computer_apps computer_open computer_wait computer_control computer_request computer_release computer_access computer_grant computer_deny computer_environment computer_prepare computer_install computer_browser computer_browser_read computer_office computer_office_read computer_put computer_artifact computer_evidence computer_await computer_cancel computer_desktop_lifecycle'],
    ['文档与图像', 'office_read office_write office_render office_export office_environment image_generate image_edit render_ui'],
    ['协作与任务', 'dispatch send threads read_thread wait_child child_status child_report child_cancel executors agent_rename ask_user question_status follow_up goal_report todo'],
    ['记忆与检索', 'memory code_retrieval retrieval_control resource_read'],
    ['环境与扩展', 'environment_forward environment_forwards environment_forward_get environment_forward_wait environment_forward_close extension_package tool_describe tool_invoke mcp_task_get mcp_task_wait mcp_task_cancel mcp_unsubscribe_resource runtime_contract update'],
    ['设置', 'settings_read settings_search settings_update settings_action'],
  ],

  shortcuts: [
    ['通用', [['打开命令面板', 'Ctrl+K'], ['打开设置', 'Ctrl+,'], ['切换侧边栏', 'Ctrl+B'], ['切换上下文面板', 'Ctrl+.'], ['轮换主题', 'Ctrl+Shift+T'], ['新建 Mini Chat 窗口', 'Ctrl+Shift+M']]],
    ['对话', [['新建会话', 'Ctrl+N'], ['聚焦输入框', 'Ctrl+L'], ['展开输入框', 'Ctrl+Shift+E'], ['打开模型选择', 'Ctrl+M'], ['轮换 Agent', 'Ctrl+Shift+A'], ['下一个收藏模型', 'Ctrl+]'], ['上一个收藏模型', 'Ctrl+['], ['语音输入', 'Ctrl+Shift+Space'], ['打开对话时间线', 'Ctrl+Shift+H'], ['显示提问导航', 'Ctrl+Shift+J'], ['把选中文字加入对话', 'Ctrl+Shift+L']]],
    ['工作区', [['打开文件', 'Ctrl+P'], ['在工作区中搜索', 'Ctrl+Shift+F'], ['打开 Git', 'Ctrl+Shift+G'], ['新建工作副本草稿', 'Ctrl+Shift+W'], ['切换计划', 'Ctrl+Shift+P'], ['切换服务菜单', 'Ctrl+Shift+S']]],
    ['编辑器', [['保存文件', 'Ctrl+S'], ['查找', 'Ctrl+F'], ['替换', 'Ctrl+H'], ['跳转到行', 'Ctrl+G'], ['重命名符号', 'F2'], ['快速修复', 'Ctrl+.'], ['在上方添加光标', 'Ctrl+Alt+↑'], ['在下方添加光标', 'Ctrl+Alt+↓']]],
    ['终端', [['显示或隐藏终端', 'Ctrl+`'], ['展开终端', 'Ctrl+Shift+`']]],
  ],
};

/* 小工具：Agent 头像（与应用里的团子形象同一思路：圆角块 + 两点眼睛） */
DATA.blob = (color, size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 26 26" aria-hidden="true"><path d="M4 9c0-4 3-6 9-6s9 2 9 6v8c0 4-3 6-9 6s-9-2-9-6z" fill="${color}"/><circle cx="10" cy="13" r="1.4" fill="#fff"/><circle cx="16" cy="13" r="1.4" fill="#fff"/></svg>`;
DATA.modelRef = (providerId, modelId) => `${providerId}/${modelId}`;
DATA.isSharedModel = modelId => DATA.services.filter(service => service.models.some(model => model.id === modelId)).length > 1;
DATA.model = ref => {
  if (!ref) return null;
  for (const service of DATA.services) {
    const model = service.models.find(item => DATA.modelRef(service.id, item.id) === ref || item.id === ref);
    if (model) return { ...model, service, ref: DATA.modelRef(service.id, model.id) };
  }
  return null;
};
DATA.usedBy = (providerId, modelId) => Object.entries(DATA.roles)
  .filter(([key, role]) => K.get('role.' + key, DATA.model(role.def)?.ref || '') === DATA.modelRef(providerId, modelId))
  .map(([, role]) => role.l);
