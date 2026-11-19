// Members, groups and the scripted scenes. Each scene builds fresh state so "重来" starts over.
const BOTS = {
  varin: { id: 'varin', name: 'Varin', color: '#4b6fac', fig: 'assets/varin.svg', role: '总助手' },
  ops: { id: 'ops', name: 'Ops', color: '#2f8a83', fig: 'assets/ops.svg', role: '发布与运维' },
  qa: { id: 'qa', name: 'QA', color: '#5f8f45', fig: 'assets/qa.svg', role: '测试' },
  design: { id: 'design', name: 'Design', color: '#b5677d', fig: 'assets/design.svg', figAsleep: 'assets/design-asleep.svg', role: '设计' },
  docs: { id: 'docs', name: 'Docs', color: '#7d68b5', fig: 'assets/docs.svg', role: '文档' },
  data: { id: 'data', name: 'Data', color: '#b8862f', fig: 'assets/data.svg', role: '数据分析' },
  sec: { id: 'sec', name: 'Sec', color: '#5d6673', fig: 'assets/sec.svg', role: '安全审计' },
};

let seq = 100;
const nid = () => `p${++seq}`;
const member = (bot, listening = false, by = null) => ({ bot, listening, by });
const user = (html, o = {}) => ({ id: o.id || nid(), type: 'msg', author: 'user', html, time: o.time || '', to: o.to || [], kind: o.kind || 'none', rc: o.rc || {}, ...o });
const botMsg = (author, html, o = {}) => ({ id: o.id || nid(), type: 'msg', author, html, time: o.time || '', rc: o.rc || {}, ...o });
const event = (html, o = {}) => ({ id: nid(), type: 'event', html, icon: o.icon || null, time: o.time || '' });
const day = (label) => ({ id: nid(), type: 'day', html: label });
const at = (id) => `<span class="mention" data-bot="${id}">@${BOTS[id].name}</span>`;

const baseGroups = () => ({
  release: { id: 'release', name: 'Release', members: [member('varin'), member('ops'), member('qa')], left: [], posts: [day('今天'), event('你创建了群聊，邀请了 Varin、Ops、QA', { time: '13:58', icon: 'users' })], unread: 0 },
  review: { id: 'review', name: '设置页评审', members: [member('varin', true, { who: 'user', time: '昨天' }), member('qa'), member('design')], left: [], posts: [], unread: 1,
    preview: 'Varin：深色主题的对比度…' },
  weekly: { id: 'weekly', name: '周会', unread: 0,
    members: ['varin', 'ops', 'qa', 'design', 'docs', 'data', 'sec'].map(id => member(id, id === 'varin', id === 'varin' ? { who: 'user', time: '周一' } : null)), left: [],
    schedules: [
      { id: 'wk-sum', owner: 'varin', name: '周会汇总', when: '09:00', day: '下周一', rule: '每周一 09:00', repeat: true, missed: '补一次' },
      { id: 'wk-crash', owner: 'data', name: '崩溃率日报', when: '18:00', day: '明天', rule: '工作日 18:00', repeat: true, missed: '跳过' },
    ],
    watches: [{ id: 'wk-adv', owner: 'sec', name: '依赖安全公告', source: 'GitHub Advisory · astrmira/varin', state: '关注中', note: '有新公告时 Sec 在群里说' }],
    posts: [day('上周五'),
      event('你创建了群聊，邀请了 Varin、Ops 等 7 位', { time: '17:40', icon: 'users' }),
      event('Varin 新建了日程「周会汇总」· 每周一 09:00', { time: '17:42', icon: 'calendar' }),
      day('周一'),
      botMsg('varin', '上周：0.9.50 已发布，崩溃率回落；本周待定：0.9.51 发布、设置页改版合并。', { time: '09:00', sched: '周会汇总', rc: {} }),
      user('这周的重点是 0.9.51 发布，有阻塞的在这里说。', { id: 'wk1', time: '09:02', to: ['varin'], kind: 'listening', rc: { varin: 'replied' } }),
      botMsg('varin', '收到。Ops 出镜像，QA 跑回归，Docs 更新发布说明；有阻塞直接 @ 我。', { time: '09:03', replyTo: 'wk1' }),
      user(`${at('data')} ${at('sec')} 上周的崩溃率和依赖审计也一起看下。`, { id: 'wk2', time: '09:05', to: ['data', 'sec'], kind: 'mention', rc: { data: 'replied', sec: 'replied' } }),
      botMsg('data', '崩溃率 0.21%，比上周低 0.05 个百分点，主要来自 macOS 挂载。', { time: '09:06', replyTo: 'wk2' }),
      botMsg('sec', '依赖审计没有高危项；两个中危已经有升级 PR。', { time: '09:07', replyTo: 'wk2' })] },
  daily: { id: 'daily', name: '日常', members: [member('varin'), member('ops')], left: ['design'], posts: [], unread: 0, preview: '你：备忘…' },
});

const SCENES = {
  release: {
    label: '发布群', group: 'release', asleep: [],
    setup(state) { state.groups.release.unread = 0; },
    steps: [
      { label: '请 Varin 接住没指定对象的消息', async run() {
        await typeDraft([['at', 'varin'], ' 这里没 @ 人的消息，你来接。']);
        await wait(700); const post = sendDraft();
        await botAnswer('varin', post, '好。之后这里没指定对象的消息由我来接，需要别人做的我会点名。', { think: 900 });
        await wait(500); setListening('release', 'varin', true, { who: 'self', time: now() });
        addPost(event(`${name('varin')} 开始接收未指定对象的消息`, { icon: 'ear', time: now() }));
        flashMember('varin');
      } },
      { label: '不 @ 任何人：交给在听的 Varin', async run() {
        await typeDraft(['这次先发 Windows 版。']);
        await wait(900); const post = sendDraft();
        await botAnswer('varin', post, '好，Windows 先发；macOS 等 FSKit 真机验证过再跟。镜像我交给 Ops。', { think: 1000 });
      } },
      { label: 'Varin 在群里把活交给 Ops', async run() {
        const handoff = await botPost('varin', `${at('ops')} 这次发布的镜像交给你：Windows x64 先出，签名后推到 GHCR，好了在这里说一声。`, { to: ['ops'], handoff: 'request', think: 700 });
        handoff.rc = { ops: 'working' }; refreshPost(handoff); setActivity('ops', 'thinking');
        await wait(1300);
        const work = { title: '构建 Windows 镜像 v0.9.51', owner: 'ops', status: 'running', step: 1, steps: ['拉取 v0.9.51 标签', '构建 x64 安装包', '签名', '推送到 GHCR'] };
        await botAnswer('ops', handoff, '开始了，进度看这里。', { work, think: 0 });
        setActivity('ops', 'working', '构建镜像');
        for (let i = 2; i <= 4; i += 1) { await wait(900); work.step = i; refreshWork(work); }
      } },
      { label: 'Ops 做完了，向你提一个请求', async run() {
        const work = findWork('构建 Windows 镜像 v0.9.51'); if (work) { work.step = 4; work.status = 'done'; refreshWork(work); }
        setActivity('ops', 'idle'); S.clock += 18; if (work) work.doneAt = now(); await wait(600);
        await botPost('ops', '<p>镜像好了，已签名并推到 GHCR：</p><pre><code>ghcr.io/astrmira/varin:0.9.51-windows-x64</code></pre><p>还差一步：能帮我把这个包设为公开吗？我这边没有组织的权限。</p>', { id: 'ops-ask', think: 600 });
      } },
      { label: '点「回复」：只发给 Ops；Ops 顺手定了明天的日程', async run() {
        actOnMessage('ops-ask', 'reply'); await wait(900);
        openRoutePop(); await wait(1900); closePop();
        await typeDraft(['好了，已经设为公开。']); await wait(700);
        const post = sendDraft();
        await botAnswer('ops', post, '确认了，匿名拉取正常。Windows 版发布完成。明天上午我再看一眼下载量，有异常在这里说。', { think: 1100 });
        await wait(700);
        addSchedule('release', { id: 'rel-dl', owner: 'ops', name: '检查 0.9.51 下载量', when: '10:00', day: '明天', rule: '仅一次 · 明天 10:00', repeat: false, missed: '补一次' });
        addPost(event(`${name('ops')} 新建了日程「检查 0.9.51 下载量」· 明天 10:00`, { icon: 'calendar', time: now() }));
      } },
    ],
  },
  review: {
    label: '并发与异常', group: 'review', asleep: ['design'],
    setup(state) {
      const g = state.groups.review; g.preview = '';
      g.posts = [day('昨天'),
        user('改版稿放这里了，明天合并。', { time: '18:40', to: ['varin'], kind: 'listening', rc: { varin: 'silent' }, att: { name: 'settings-redesign.pdf', size: '2.4 MB', type: 'PDF' } }),
        day('今天')];
    },
    steps: [
      { label: '同时问三位：两位并发回复，一位在休息', async run() {
        await typeDraft([['at', 'varin'], ' ', ['at', 'qa'], ' ', ['at', 'design'], ' 从各自的角度看看，合并前还有什么风险？']);
        await wait(800); const post = sendDraft();
        const qa = botAnswer('qa', post, '<p>测试这边：设置页的窄屏布局还没有自动化覆盖，我想先跑一遍 e2e 再下结论。</p>', { think: 1100, speed: 26,
          ask: { kind: 'permission', who: 'qa', title: '想运行一条命令', where: '本机 · Varin 仓库', cmd: 'bun run test:e2e -- --project=settings', state: 'pending', follow: 'qa-e2e' } });
        const varin = botAnswer('varin', post, VARIN_REVIEW, { think: 1500, speed: 34, fold: true });
        await Promise.all([qa, varin]);
      } },
      { label: '在群里批准 QA 的操作', async run() {
        const p = findAsk('pending'); if (!p) return;
        jumpTo(p.id); await wait(800); await resolveAsk(p.id, 'once');
      } },
      { label: '唤醒 Design，只重发给它', async run() {
        const p = currentGroup().posts.find(x => x.rc && x.rc.design === 'asleep'); if (!p) return;
        jumpTo(p.id); await wait(600); await wakeAndRetry(p.id, 'design');
      } },
    ],
  },
  create: {
    label: '新建群聊', group: 'release', asleep: [],
    setup(state) {
      const g = state.groups.release;
      g.posts.push(user(`${at('varin')} 这里没 @ 人的消息，你来接。`, { time: '14:01', to: ['varin'], kind: 'mention', rc: { varin: 'replied' } }));
      g.posts.push(botMsg('varin', '好。之后这里没指定对象的消息由我来接，需要别人做的我会点名。', { time: '14:01' }));
      g.members[0].listening = true; g.members[0].by = { who: 'self', time: '14:01' };
    },
    steps: [
      { label: '从「新建会话」的菜单开始', async run() { openMenu('new'); } },
      { label: '只需要名称和成员', async run() {
        closePop(); openDialog(); await wait(500);
        await typeField('#gname', '周报'); await wait(300);
        togglePick('varin'); await wait(350); togglePick('qa'); await wait(350);
      } },
      { label: '创建：空群告诉你怎么让成员接话', async run() { createGroup(); } },
      { label: '用一句话请成员接话', async run() { const b = document.querySelector('.starters button'); if (b) b.click(); } },
    ],
  },
  edges: {
    label: '地址与送达', group: 'daily', asleep: [],
    setup(state) {
      const g = state.groups.daily; g.preview = '';
      g.posts = [day('昨天'),
        botMsg('ops', '测试机的镜像缓存我清过一次，现在占用 61%。', { id: 'ops-disk', time: '17:12' }),
        event('Design 离开了群聊，之前的发言保留署名', { icon: 'users', time: '17:30' }),
        user('备忘：下周把 0.9.52 的依赖更新整理一下。', { time: '18:05', to: [], kind: 'none', att: { name: 'deps-0.9.52.md', size: '6 KB', type: 'MD' } }),
        day('今天'),
        user(`${at('ops')} 测试机的磁盘还剩多少？`, { id: 'ask-disk', time: '09:12', to: ['ops'], kind: 'mention', rc: { ops: 'failed' } })];
      state.pendingDraft = [['at', 'design'], ' 圆角这版再帮我看一眼？'];
    },
    steps: [
      { label: '收不到的地址，发送前就拦下', async run() { const b = document.querySelector('[data-act="drop-gone"]'); if (b) b.click(); } },
      { label: '回复 + @：引用原作者，发给被 @ 的人', async run() {
        clearDraft(); actOnMessage('ops-disk', 'reply'); await wait(1200);
        await typeDraft([['at', 'varin'], ' 帮我盯一下，超过 80% 提醒我。']); await wait(400);
        openRoutePop(); await wait(2000); closePop();
      } },
      { label: '重新发送给没收到的 Ops', async run() {
        jumpTo('ask-disk'); await wait(500); await retryDelivery('ask-disk', 'ops');
      } },
    ],
  },
};

const VARIN_REVIEW = `<p>整体可以合并，有三点建议：</p>
<ol><li><b>旧地址</b>：<code>sessions</code>、<code>network</code> 这些旧入口要继续能打开。别名表已经覆盖，但还没有测试。</li>
<li><b>保存方式</b>：「测试并保存」和「立即保存」在同一页时，离开页面的拦截要统一，不然草稿可能丢。</li>
<li><b>手机布局</b>：630px 以下目录页分成列表和详情两段，返回手势要和系统一致。</li></ol>
<p>深色主题下分组标题的对比度偏低，这个更适合 Design 判断。合并顺序上，我建议先合旧地址和保存方式，手机布局单独一个 PR，方便回滚。</p>`;

// Replies for messages typed freely in the prototype. Listeners stay quiet unless asked something.
const FREE_REPLIES = {
  varin: '好，我记下了。需要别人接手的话我会在这里点名。',
  ops: '收到，我这边看一下，有结果在这里说。',
  qa: '好，我加到回归清单里，跑完告诉你。',
  design: '我看一下，稍后给你具体的修改建议。',
};
