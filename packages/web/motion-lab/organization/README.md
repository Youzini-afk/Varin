# Conversation Organization Motion Lab

Run from the repository root:

```sh
bun x vite --config packages/web/motion-lab/vite.config.ts
```

Open `http://localhost:5199/?scene=organization`. The top bar toggles Workbench, Bot, IDE, light/dark themes, and narrow viewports.

Reuses product themes, icons, `AgentAvatar`, `BotFigure`, `ChatTimeline`, `ThreadComposer`, menus, dialogs, inputs, toasts, `FlipList`, and selection/hover motion using local fixture data only (never connects to a live Application Host; IDE editor area is layout backdrop without Monaco).
