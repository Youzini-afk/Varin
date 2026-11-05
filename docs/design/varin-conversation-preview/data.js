/* Varin · 总助手设计稿 · 示例数据（不连接 Host） */
(function () {
  'use strict';
  const VC = window.VC = window.VC || {};

  VC.data = {
    agents: {
      builder: { name: 'Builder', art: 'slant-mint' },
      reviewer: { name: 'Reviewer', art: 'pebble-blue' },
      writer: { name: 'Writer', art: 'notch-ochre' },
      researcher: { name: 'Researcher', art: 'slope-lilac' },
      scout: { name: 'Scout', art: 'taper-sage' },
      keeper: { name: 'Keeper', art: 'dome-ivory' },
    },
    sessions: [
      { id: 's1', title: '发布季准备', state: 'live' },
      { id: 's2', title: '旅行安排', state: 'run' },
      { id: 's3', title: '日常', state: '' },
    ],

    /* 正在跟进：来自原工作与 matter 关联；顺序稳定，状态原位更新 */
    works: [
      { id: 'w1', name: '发布页面', session: 's1', team: ['builder', 'reviewer'], lead: 'builder',
        state: { kind: 'run', text: 'Reviewer 正在办公电脑上检查移动端' },
        links: [['results', '成果 3'], ['computer', '办公电脑'], ['files', '文件']] },
      { id: 'w2', name: '整理汇报材料', session: 's1', team: ['writer'], lead: 'writer',
        state: { kind: 'need', text: 'Writer 想先确认汇报的组织方式' },
        links: [['need', '查看问题'], ['results', '成果 1']] },
      { id: 'w3', name: '竞品价格调研', session: 's1', team: ['researcher'], lead: 'researcher',
        state: { kind: 'result', text: '已送回结果 · Varin 整理在对话里' },
        links: [['report', '回报'], ['results', '成果 2']] },
      { id: 'w4', name: '机票比价', session: 's2', team: ['scout'], lead: 'scout',
        state: { kind: 'run', text: 'Scout 正在比较 3 家航司的退改规则' }, links: [['results', '成果 1']] },
      { id: 'w5', name: '依赖升级', session: 's3', team: ['keeper'], lead: 'keeper',
        state: { kind: 'queued', text: '排队中 · 等开发服务器上的构建结束' }, links: [] },
    ],
    recent: [
      { name: '首页文案改写', by: 'writer', meta: 'Writer · 昨天 18:40 · 首页改版', unread: true },
      { name: '发布清单 v2', by: null, meta: 'Varin · 昨天 16:05', unread: false },
    ],
    env: {
      computers: [{ id: 'c1', name: '办公电脑', meta: 'Reviewer 正在使用 · 发布页面' }],
      files: [{ id: 'f1', name: '网站项目', meta: '开发服务器 · /srv/website' }],
    },

    /* 当前会话正文：开放排版；短操作只留可展开的活动记录 */
    chat: [
      { t: 'day', text: '今天' },
      { t: 'u', time: '10:58', text: '发布页面的移动端还是有点挤，帮我调一下。汇报材料周五前要，先出个大纲给我看看。' },
      { t: 'a', id: 'm1',
        act: { icons: ['file', 'bot'], label: '读取文件', more: 1, title: '读取文件 2 · 交办工作 2', items: [['读取', 'docs/launch/brief.md'], ['读取', 'reports/2026-Q3/outline-draft.md'], ['交办', '发布页面 → Builder（负责人）'], ['交办', '整理汇报材料 → Writer']] },
        html: '<p>好，两件事分开推进。</p><ul><li><b>移动端布局</b>交给 Builder，在开发服务器的网站项目里改；改完让 Reviewer 在办公电脑上按真机尺寸看一遍。</li><li><b>汇报材料</b>由 Writer 起草大纲。它有一处想先跟你确认，放在下面了。</li></ul>',
        wrefs: ['w1', 'w2'], req: 'w2' },
      { t: 'u', time: '11:15', text: '顺便，上个月云服务一共花了多少？' },
      { t: 'a', id: 'm2',
        act: { icons: ['file'], label: '读取文件', items: [['读取', '账单/billing-2026-10.csv · 2,140 行'], ['读取', '账单/billing-2026-09.csv · 1,988 行']] },
        html: '<p>10 月合计 <b>¥3,482.60</b>，比 9 月多 12%，主要多在对象存储的流量费。</p><table><thead><tr><th>项目</th><th class="r">9 月</th><th class="r">10 月</th></tr></thead><tbody><tr><td>计算实例</td><td class="r">¥1,920.00</td><td class="r">¥1,936.40</td></tr><tr><td>对象存储（含流量）</td><td class="r">¥702.30</td><td class="r up">¥1,012.20</td></tr><tr><td>数据库</td><td class="r">¥488.00</td><td class="r">¥488.00</td></tr><tr><td>其他</td><td class="r">¥ 44.10</td><td class="r">¥ 46.00</td></tr></tbody></table><p>流量涨在 10 月 18 日以后，和新版首页的大图上线时间一致。需要的话我可以让 Builder 顺手把图片压一下。</p>' },
      /* 回报沿用现有的子 Agent 消息：发送者 → 接收者，默认折叠两行；它到达时唤醒 Varin，没有“未读取”状态 */
      { t: 'report', id: 'r1', from: 'researcher', time: '11:24', work: 'w3',
        text: '竞品价格调研完成。6 家竞品的公开价格都已整理进「价格对比表.xlsx」，按个人版、团队版、企业版三档对齐。主要发现：\n1. 企业版普遍不公开标价，6 家里有 4 家需要联系销售；\n2. 团队版的中位价是每人每月 ¥58，我们的 ¥49 处在偏低的位置；\n3. 两家在 10 月下调了个人版价格，降幅 15% 左右。\n口径说明：价格取各家官网 11 月 5 日的页面，按年付折算月价，未含税。' },
      { t: 'a', id: 'm3',
        act: { icons: ['doc'], label: '读取回报', items: [['读取', 'Researcher 的回报 · 竞品价格调研'], ['读取', '价格对比表.xlsx · 6 家 × 3 档']] },
        html: '<p>竞品价格调研回来了。我们团队版每人每月 ¥49，比 6 家竞品的中位价 ¥58 低一截；企业版大多不公开标价，没法直接比。</p><p>有两家在 10 月把个人版降了 15% 左右，如果你打算调价，这个值得一起看。对比表已经附在工作里。</p>',
        wrefs: ['w3'] },
    ],

    /* 工作详情：简明状态、需要你的事、当前成果、使用的环境、执行者；完整过程去原工作台 */
    detail: {
      w1: { tag: ['进行中', ''], meta: ['本会话「发布季准备」', '11:02 开始', '负责人 Builder'],
        now: { spin: true, text: 'Reviewer 正在办公电脑上检查移动端', sub: '11:26 起' },
        feed: [
          ['11:26', 'reviewer', '在 <b>办公电脑</b> 打开 Chrome，切到 390 × 844', true],
          ['11:24', 'builder', '交给 Reviewer 检查'],
          ['11:22', 'builder', '截图 <b>移动端预览 v3</b>'],
          ['11:21', 'builder', '运行 <code>npm run build</code> · 通过'],
          ['11:20', 'builder', '修改 <code>src/styles/hero.css</code> <span class="d">+18</span> <span class="dd">−6</span>'],
        ],
        arts: [
          { kind: 'shot', t: '移动端预览', m: 'Builder · 11:22', vers: ['v1', 'v2', 'v3'], acts: ['打开', '引用到对话'] },
          { kind: 'diff', t: '改动 2 个文件', m: '<span class="d">+24</span> <span class="dd">−9</span> · hero.css、nav.tsx', acts: ['查看差异'] },
          { kind: 'link', t: '预览地址', m: 'http://dev-server:5173 · 经家中主机访问', acts: ['打开'] },
        ],
        env: [
          { k: 'files', t: '文件 · 开发服务器', m: '发布页面工作区：独立工作区，基于网站项目 main。项目原目录另外打开。' },
          { k: 'computer', t: '电脑 · 办公电脑', m: '桌面 1 · Reviewer 正在操作' },
        ],
        team: [{ a: 'builder', role: '负责人', state: '等 Reviewer 的结果' }, { a: 'reviewer', sub: true, role: '检查', state: '正在检查', spin: true }],
        to: 'Builder' },
      w2: { tag: ['等你决定', 'warn'], meta: ['本会话「发布季准备」', '11:03 开始', 'Writer'],
        now: { need: true, text: 'Writer 在等你回答：汇报按什么组织？', sub: '11:09 提出' },
        feed: [['11:09', 'writer', '提出问题：汇报按什么组织？', true], ['11:08', 'writer', '写出 <b>大纲草稿 v1</b>'], ['11:04', 'writer', '读取 <code>reports/2026-Q3/*</code> · 14 个文件']],
        arts: [{ kind: 'doc', t: '大纲草稿', m: 'Writer · 11:08', vers: ['v1'], acts: ['打开'] }],
        env: [{ k: 'files', t: '文件 · 家中主机', m: '文档 / 汇报 / 2026-Q3' }],
        team: [{ a: 'writer', role: '执行者', state: '等你回答' }], to: 'Writer' },
      w3: { tag: ['已送回结果', ''], meta: ['本会话「发布季准备」', '10:40 开始', 'Researcher'],
        now: { result: true, text: '11:24 送回结果，Varin 已在对话里整理', sub: '回报原文可以直接看' },
        feed: [['11:25', 'researcher', 'Varin 读取了回报，在对话里回复你', true], ['11:24', 'researcher', '送回结果'], ['11:19', 'researcher', '写出 <b>价格对比表.xlsx</b>'], ['10:52', 'researcher', '搜索 6 家竞品的公开价格页']],
        arts: [{ kind: 'doc', t: '原始回报', m: 'Researcher · 11:24 · 1,240 字', acts: ['打开'] }, { kind: 'sheet', t: '价格对比表.xlsx', m: '6 家 × 3 档 · 11:19', acts: ['打开', '引用到对话'] }],
        env: [], team: [{ a: 'researcher', role: '执行者', state: '已结束这次执行' }], to: 'Researcher' },
    },

    question: { from: 'writer', work: 'w2', q: '汇报按什么组织？',
      opts: [['按产品线', '每条线一页，讲清进展和下季目标；适合给管理层。'], ['按季度时间线', '按月份串起来，更容易看出趋势；适合复盘。']] },

    timeline: [
      ['11:26', '<b>Reviewer</b> 开始在办公电脑上检查「发布页面」'],
      ['11:24', '<b>Researcher</b> 送回「竞品价格调研」的结果'],
      ['11:15', '直接回答了云服务账单的问题'],
      ['11:09', '<b>Writer</b> 提出一个问题，等你决定'],
      ['11:02', '交办「发布页面」给 <b>Builder</b>，交办「整理汇报材料」给 <b>Writer</b>'],
    ],
    memory: [
      ['汇报材料先给大纲，确认后再写正文。', '10 月 21 日 · 来自「发布季准备」'],
      ['移动端以 390 × 844 为主要检查尺寸。', '10 月 30 日 · 你在工作台的改动'],
    ],

    /* 文件：显式来源；任务视图与项目原目录分开 */
    locations: [
      { group: '这项工作', items: [{ id: 'ws', name: '发布页面工作区', sub: '开发服务器 · 独立工作区', dot: 'ok' }] },
      { group: '设备', items: [
        { id: 'dev', name: '开发服务器', sub: '/srv/website · 网站项目', dot: 'ok' },
        { id: 'home', name: '家中主机', sub: '本机 · D:\\ 工作', dot: 'ok' },
        { id: 'office', name: '办公电脑', sub: '文档、下载', dot: 'ok' },
      ] },
    ],
    files: [
      { n: 'components', dir: true, d: '11:20' },
      { n: 'hero.css', s: '6.2 KB', d: '11:20', sel: true },
      { n: 'nav.css', s: '2.9 KB', d: '11:18' },
      { n: 'tokens.css', s: '4.1 KB', d: '10 月 30 日' },
      { n: 'mobile.css', s: '1.7 KB', d: '10 月 30 日' },
      { n: 'print.css', s: '0.8 KB', d: '9 月 12 日' },
    ],

    /* 连接：资源设备、Varin 服务、访问客户端分开管理 */
    devices: [
      { id: 'd0', name: '家中主机', kind: 'desktop', os: 'Windows 11', via: 'Varin 服务所在的设备',
        caps: [['文件', 'ok', ''], ['执行环境', 'ok', 'PowerShell · Node 24'], ['桌面', 'ok', '桌面 1']] },
      { id: 'd1', name: '开发服务器', kind: 'server', os: 'Ubuntu 24.04', via: 'SSH · youzi@10.0.0.12 · 由家中主机连接',
        caps: [['文件', 'ok', ''], ['执行环境', 'ok', 'bash · Node 24'], ['桌面', 'no', '没有图形桌面']] },
      { id: 'd2', name: '办公电脑', kind: 'desktop', os: 'Windows 11', via: '连接地址 · https://office.lan:7456',
        caps: [['桌面', 'ok', '桌面 1、桌面 2'], ['文件', 'ok', ''], ['执行环境', 'off', '该设备未开启']] },
    ],
    services: [
      { name: '家中主机', m: '本机 · 3 个会话有工作在进行', cur: true },
      { name: '实验室服务器', m: 'https://lab.example.com · 上次使用 10 月 28 日' },
    ],
    clients: [
      { name: 'iPhone 16', m: '已配对 · 2 分钟前在线', ic: 'phone' },
      { name: '办公室笔记本 · Chrome', m: '已配对 · 昨天 19:12', ic: 'laptop' },
    ],
  };
})();
