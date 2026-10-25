import React from 'react';
import { splashCubeMarkup } from '@/components/ui/varin-splash-cube';
import { VARIN_SPLASH_COLORS, splashPlaneCss } from '@/components/ui/varin-splash-lattice';
import { dismissInitialSplash } from '@/lib/splash';

/**
 * Startup scene: the pre-paint splash (its generated stylesheet and markup, without the floor Canvas,
 * whose opaque fallback keeps the cover) over stand-ins for the parts the entrance stages.
 * `window.__startup.dismiss(shownMs)` tells the splash to leave as `App` does, as if it had been on
 * screen for `shownMs`; frames record the cover and every part's opacity and offset.
 */

const installSplash = (): void => {
  if (document.getElementById('initial-loading')) return;
  const style = document.createElement('style');
  style.textContent = splashPlaneCss(VARIN_SPLASH_COLORS, { withMark: true });
  document.head.append(style);
  const splash = document.createElement('div');
  splash.id = 'initial-loading';
  splash.className = 'varin-splash';
  splash.dataset.leaving = 'false';
  splash.innerHTML = `<div class="varin-splash-backdrop"></div><div class="varin-splash-ground-clip"><div class="varin-splash-horizon"><canvas class="varin-splash-ground-canvas"></canvas><div class="varin-splash-camera"><div id="initial-loading-ground" class="varin-splash-ground"></div><span class="varin-splash-mark">${splashCubeMarkup()}</span></div></div></div><div id="initial-loading-status" class="varin-splash-status"></div>`;
  document.body.prepend(splash);
};

const PARTS = ['sidebar', 'header', 'hero', 'composer', 'rail'] as const;

interface StartupSample {
  t: number;
  splash: number | null;
  exit: string | null;
  entrance: boolean;
  parts: Record<string, { opacity: number; x: number; y: number }>;
  starters: number[];
}

const offset = (element: Element) => {
  const translate = getComputedStyle(element).translate;
  const [x = '0', y = '0'] = translate === 'none' ? [] : translate.split(' ');
  return { x: parseFloat(x) || 0, y: parseFloat(y) || 0 };
};

export function StartupLab() {
  React.useState(installSplash);
  React.useEffect(() => {
    let recording: StartupSample[] | null = null;
    let frame = 0;
    const sample = () => {
      if (recording) {
        const splash = document.getElementById('initial-loading');
        recording.push({
          t: performance.now(),
          splash: splash ? Number(getComputedStyle(splash).opacity) : null,
          exit: splash?.getAttribute('data-exit') ?? null,
          entrance: document.documentElement.hasAttribute('data-startup-entrance'),
          parts: Object.fromEntries(PARTS.map((part) => {
            const element = document.querySelector(`[data-startup-part="${part}"]`)!;
            return [part, { opacity: Number(getComputedStyle(element).opacity), ...offset(element) }];
          })),
          starters: [...document.querySelectorAll('.oc-draft-starters > *')].map(chip => Number(getComputedStyle(chip).opacity)),
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      dismiss(shownMs: number) {
        // The splash reads how long it has been up from the page clock, once, synchronously.
        const clock = performance.now;
        performance.now = () => shownMs;
        try { dismissInitialSplash(); } finally { performance.now = clock; }
        return performance.now();
      },
    };
    (window as unknown as { __startup: typeof lab }).__startup = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  return <div className="flex h-full flex-col bg-background text-foreground">
    <header data-startup-part="header" className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
      <span className="rounded-md bg-interactive-hover px-2 py-0.5 typography-meta font-medium">工作台 ▾</span>
      <span className="typography-meta text-muted-foreground">新会话</span>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside data-startup-part="sidebar" className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3">
        {['重构登录模块', '修复会话同步', '整理发布说明'].map(title => <div key={title} className="rounded-md px-2 py-1.5 typography-ui-label">{title}</div>)}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8">
        <div data-startup-part="hero" className="flex flex-col items-center gap-3">
          <h1 className="text-3xl font-medium tracking-tight">今天想做什么？</h1>
        </div>
        <div data-startup-part="composer" className="h-28 w-full max-w-2xl rounded-2xl border border-border bg-background shadow-sm" />
        <div className="oc-draft-starters flex flex-wrap justify-center gap-2">
          {['解释这个仓库', '写测试', '修复构建', '整理变更', '安排任务'].map(label => (
            <span key={label} className="rounded-full border border-border px-3 py-1 typography-meta">{label}</span>
          ))}
        </div>
      </main>
      <nav data-startup-part="rail" className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border py-3">
        {[0, 1, 2].map(index => <span key={index} className="size-5 rounded bg-muted-foreground/25" />)}
      </nav>
    </div>
  </div>;
}
