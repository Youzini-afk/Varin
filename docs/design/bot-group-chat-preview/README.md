# Bot group chat — interface prototype

Interactive prototype for [Bot group chat](../bot-group-chat.md). Open `index.html` directly in a browser; no build step. The dark bar at the top belongs to the prototype, not the product: it switches scenes, plays each scene step by step (下一步), and toggles desktop/phone and light/dark. Everything inside the frame is clickable, and free typing works: `@` a member, reply to a bubble, switch a member's listening, wake a sleeping member.

Figures in `assets/` are the real built-in Varin figure exported from the running app, one file per sample Bot accent. Tokens follow `varin-light` / `varin-dark`.

## Layout

```
titlebar   [≡] [Varin ▾]  Release · Varin、Ops、QA                  [search] [member stack = panel toggle]
sidebar    新建会话 ▾ (和 Varin 新会话 / 新建群聊… / 新建 Bot…)
           群聊   cluster + name + last line, live/needs-you/unread mark
           助手   Bots with their direct sessions, unchanged
canvas     timeline (user right, Bots left) + composer
panel      group mark + name + who listens, ··· (添加成员 / 群文件 / 搜索 / 删除) · icon tabs 成员 / 动态 / 日程
           a member opens with its figure on the ledge
phone      title opens the same panel as a sheet; long-press a bubble for its actions
```

## Decisions

- **The composer says who will get the message.** Where the direct chat shows the model, the group shows `发给 Varin · 在听`. It follows the delivery rule live: explicit `@` first, then the reply target, then listening members, else `仅记录`. The recipient popover lists every member with the reason (被 @ / 回复对象 / 在听 / 在听 · 这条不发给它 / 被引用 · 这条不发给它). Checking a member edits the `@` in the draft and adds to the current recipients rather than replacing them. A group has no shared model, so there are no model, thinking or focus controls here.
- **Reply versus quote is visible before sending.** Replying to Ops shows `回复 Ops` above the input. Adding `@Varin` turns it into `引用 Ops` and sends to Varin. The 引用 action adds context and never addresses anyone. Pasted text stays plain text, so names inside it never become addresses.
- **Unreachable addresses are stopped before sending.** A member who left shows as a struck-through token with `去掉 @Design` / `改发给…`, and send is disabled. A sleeping recipient gets a quiet note with `现在唤醒`. The post can still be sent.
- **Receipts say who received a post and stay quiet unless something needs attention.** Each user post shows its time and small avatars of its recipients. A spinning ring means the member is working on it. A dimmed avatar means it received the post and chose not to answer, so a silent turn leaves no empty bubble. Only the affected member gets a line of its own: `Design 在休息，没收到这条 · 唤醒并重新发送`, or `Ops 没收到：连接中断 · 重新发送给 Ops`. A retry goes only to that member.
- **Thinking shows above the composer; bubbles appear only with text.** `Varin、QA 正在想…` sits above the input. A bubble appears when real text starts streaming, and concurrent answers stream in separate bubbles. Anything waiting for you that is out of view becomes a pill there (`QA 等你批准`).
- **Quotes appear only where they help.** An answer directly below the post it answers has no quote, even when several members answer the same post. A later answer, or one after other messages in between, shows a one-line quote that jumps to the original. Consecutive posts by the same speaker within five minutes share one avatar and name.
- **Bot-to-Bot handoffs read as messages.** The name line reads `Varin → Ops` (`· 告知` for informational handoffs), and the recipient's receipt shows its progress. Shared work is a card in the bubble that opens the task in the panel's 动态, with steps, an owner and `打开任务`. The task's tool trace never enters the group.
- **Approvals live in the asking member's bubble** and are bound to the real operation. Once decided, the card shrinks to a one-line record.
- **"在听" is the short name** for 接收未指定对象的用户消息, marked with an ear icon. The member list puts a switch on each row under one column header, and the panel header says who listens. A Bot's own change shows its source (`Varin 自己打开 · 14:01`), and every change also leaves a fact line in the timeline. Member detail gives the full name, explains the setting, and covers 唤醒, 私聊, 资料 and 移出群聊 with its consequences.
- **The group panel has no stage.** A stage is one Bot's place; a group is not a Bot. Several figures side by side look like copies when they share the built-in art, fit no more than three or four at 360 px, and only repeat the member list. The panel opens with the group's mark (the same pair of faces as in the sidebar), its name and who listens. Member rows carry the live state (正在回复 / 处理中 · 构建镜像 / 等你批准 / 休息中) and work for any number of members. Opening a member shows its figure alone on the ledge, as on its own Bot panel, above its settings.
- **The tabs are the Bot panel's, scoped to the group.** The same icon tabs and dots as 概览 / 动态 / 记忆 / 日程, here 成员 / 动态 / 日程. A group keeps no memory of its own; each member keeps its own.
  - **动态** is what members did outside the bubbles, in the Bot panel's layout: 需要你 (approvals, a sleeping or failed recipient; the row's state turns into 去处理 on hover), 进行中 (tasks started from this group), then a dotted timeline by day, newest first: handoffs, task start and finish, `Varin 收到了，没有回复`, schedules firing, listening and membership changes, your approvals. Each entry jumps to its post or opens the task. Ordinary replies stay in the timeline only. A warn dot means something needs you, an info dot means new entries.
  - **日程** lists members' schedules and watches whose target is this group, with the owner on every row: 安排与关注, 接下来, 重复规则, details on expand, `新建日程` with the group preselected. A schedule belongs to the member who set it. When it fires, that member continues in the group like any delivered turn, and only the members it addresses receive anything. Its post says `日程「周会汇总」` in the name line, and setting one leaves a fact line in the timeline (Release scene, last step).
  - **Files** moved from a tab to ··· → 群文件. They are already in the bubbles and in search, and are opened less often than the other two.
- **Members stay distinguishable when their figures look alike.** Several Bots often share the built-in figure. Avatars crop head and collar, so the accent outfit colour shows even at 16 px, on a faint disc of the same colour.
- **New group asks only for a name and members.** The empty group shows its members' faces (five and `+n` beyond six), explains in two lines how members come to answer, and offers a starter that asks a member to take unaddressed messages.

## Scenes

| Scene | Shows |
| --- | --- |
| 发布群 | The doc's release story: a Bot turns listening on itself, an unaddressed post goes to the listener, a Bot-to-Bot handoff with shared work, and a reply that goes only to Ops. |
| 并发与异常 | Three members addressed at once: two concurrent streams, a folded long answer, an approval in the group, a sleeping member, wake and retry for that member only. |
| 新建群聊 | Creation menu, dialog, empty group, starter. |
| 地址与送达 | A member who left, blocked at send time; a note with no recipients (`仅记录`); reply plus `@` switching to a quote; a failed delivery retried. |

The sidebar's 周会 group has seven members, to check the titlebar, panel, receipts and recipient chip at a larger size. The figures for Docs, Data and Sec are generated from the exported figure with the app's own per-Bot recolouring (`resolveFigureColor`).

## Where it lands in the app

| Area | Existing place |
| --- | --- |
| Sidebar section, creation menu | `workbenches/bot/BotNavigator.tsx` |
| Titlebar, panel frame, phone sheet | `BotWorkspaceShell.tsx`, `BotPanel.tsx`, `BotMobileTitle.tsx` |
| Member detail figure | `BotFigure.tsx`, one figure as on the Bot panel |
| Bubbles, quotes, folding | `styles/collaboration.css` (`.collaboration-message*` has the bubble and fold geometry) |
| Mention picker, tokens, recipient chip | `components/chat/composer/` (`FileMentionAutocomplete`, reference tokens) |
| Approvals, questions, work cards | `ThreadPermissionControl`, `ThreadQuestions`, the delegation card, `BotWorkDetail` |
| Tabs, 动态, 日程 | `BotPanel.tsx` tabs and dots, `BotActivityPane.tsx`, `BotSchedulePane.tsx` (`BotArrangements`), filtered to the group |

## Open questions

- Sidebar: a separate 群聊 section above 助手 (as drawn), or groups placed in the existing Bot folders alongside Bots.
- Should the head-and-collar avatar with its colour disc replace the plain head crop everywhere Bots are listed, or only in group contexts? The prototype uses it everywhere.
- Silent turns show as a dimmed receipt avatar with a tooltip, and 动态 also records them. If the receipt is too much, it can show only working and trouble states and leave silent turns to 动态.
- A group schedule's target: the owner's session for this group (whose replies already publish to the group), or a new target kind. The prototype assumes the former.
