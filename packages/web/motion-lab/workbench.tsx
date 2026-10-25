import React from 'react';
import { flushSync } from 'react-dom';
import { VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@varin/extension-builtins';
import { parseVarinTransitionSceneContributionData } from '@varin/extension-contract';
import { BuiltinWorkbenchTransitionScene } from '@/components/ui/BuiltinWorkbenchTransitionScene';
import { prefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';
import {
  armWorkbenchProfileTransitionPhase,
  beginWorkbenchProfileTransition,
  createWorkbenchTransitionSceneController,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionOperationPrepared,
  revealWorkbenchProfileTransition,
  subscribeWorkbenchProfileTransition,
  waitForWorkbenchProfileTransitionCovered,
  type WorkbenchTransitionSceneController,
} from '@/lib/workbench/profile-transition';

/**
 * Workbench scene: two stand-in Shells (工作台 and IDE) under the real Core transition state
 * machine, the built-in scene's declared durations and the built-in lattice scene. The overlay here
 * mirrors WorkbenchTransitionOverlay without the extension registry: it arms each phase's clock after
 * mount and unmounts the scene at idle. `window.__wb.go(profile, { holdMs })` switches; frames record
 * the phase, the mounted Shell and a sample of cell scales.
 */

const PROFILES = ['workbench', 'ide'] as const;
type Profile = typeof PROFILES[number];
const LABEL: Record<Profile, string> = { workbench: '工作台', ide: 'IDE' };

const contributionData = VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.contributions?.[0]?.data;
const CAPTURE: WorkbenchTransitionSceneCapture = {
  contributionId: 'lab.transition',
  data: parseVarinTransitionSceneContributionData(contributionData),
  desiredRevision: 0,
  entrypointId: 'lab',
  extensionId: 'lab',
  extensionVersion: '0',
  generation: 0,
  hostId: 'lab',
  realmId: 'lab',
};

function LabTransitionOverlay() {
  const state = React.useSyncExternalStore(subscribeWorkbenchProfileTransition, getWorkbenchProfileTransitionSnapshot);
  const [held, setHeld] = React.useState<{ id: number; controller: WorkbenchTransitionSceneController } | null>(null);
  if (state.phase !== 'idle' && held?.id !== state.id) {
    setHeld({ id: state.id, controller: createWorkbenchTransitionSceneController(state.id) });
  }
  React.useEffect(() => {
    if (state.phase === 'covering' || state.phase === 'revealing') armWorkbenchProfileTransitionPhase(state.id, state.phase);
  }, [state.id, state.phase]);
  if (state.phase === 'idle' || !held || held.id !== state.id) return null;
  return (
    <div className={`fixed inset-0 z-[9998] overflow-hidden ${state.phase === 'revealing' ? 'pointer-events-none' : ''}`} data-lab-overlay={state.phase}>
      <BuiltinWorkbenchTransitionScene transition={held.controller} />
    </div>
  );
}

function TitleBar({ profile }: { profile: Profile }) {
  return <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3">
    <span className="size-3 rounded-full bg-muted-foreground/30" />
    <span className="size-3 rounded-full bg-muted-foreground/30" />
    <button type="button" data-varin-workbench-switcher="" className="ml-3 h-7 rounded-md bg-interactive-hover px-2 typography-meta font-medium">
      {LABEL[profile]} ▾
    </button>
    <span className="ml-auto typography-meta text-muted-foreground">{profile === 'ide' ? 'login.ts' : '重构登录模块'}</span>
  </header>;
}

function WorkbenchShell() {
  return <div className="flex min-h-0 flex-1" data-lab-layout="workbench">
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3">
      {['重构登录模块', '修复会话同步', '整理发布说明', '性能预算回顾'].map((title, index) => (
        <div key={title} className={`rounded-md px-2 py-1.5 typography-ui-label ${index === 0 ? 'bg-interactive-selection' : ''}`}>{title}</div>
      ))}
    </aside>
    <main className="flex min-w-0 flex-1 flex-col items-center gap-4 p-8">
      {[0, 1, 2].map(turn => (
        <div key={turn} className="flex w-full max-w-2xl flex-col gap-2">
          <div className="self-end rounded-xl bg-interactive-hover px-3 py-2 typography-markdown">第 {turn + 1} 个问题：把登录模块重构一下</div>
          <div className="typography-markdown text-foreground/90">好的。先拆出会话校验，再把表单状态收进一个 reducer，最后补上回归测试。</div>
        </div>
      ))}
      <div className="mt-auto h-24 w-full max-w-2xl rounded-2xl border border-border bg-background shadow-sm" />
    </main>
  </div>;
}

function IdeShell() {
  return <div className="flex min-h-0 flex-1" data-lab-layout="ide">
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-2 font-mono text-[12px]">
      {['src/', '  auth/', '    login.ts', '    session.ts', '  LoginForm.tsx', 'tests/', '  auth.test.ts'].map(line => (
        <div key={line} className={`whitespace-pre rounded px-2 py-0.5 ${line.includes('login.ts') ? 'bg-interactive-selection' : ''}`}>{line}</div>
      ))}
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-8 items-center gap-4 border-b border-border px-3 typography-meta">login.ts<span className="text-muted-foreground">session.ts</span></div>
      <pre className="flex-1 p-4 font-mono text-[12px] leading-6 text-foreground/90">{`export async function login(form: LoginForm) {\n  const session = await verify(form);\n  if (!session.ok) return fail(session.reason);\n  return commit(session.value);\n}`}</pre>
      <div className="h-40 border-t border-border bg-sidebar p-3 font-mono text-[12px] text-muted-foreground">$ bun test auth</div>
    </main>
    <aside className="w-80 shrink-0 border-l border-border p-4 typography-meta text-muted-foreground">对话</aside>
  </div>;
}

interface WorkbenchSample {
  t: number;
  phase: string;
  layout: string | null;
  /** Sampled cells' scale, in the order of `reach` (distance from the switcher, nearest first). */
  scales: number[];
  hold: number;
  sheet: number | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nextPaint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export function WorkbenchLab() {
  const [profile, setProfile] = React.useState<Profile>('workbench');
  const profileRef = React.useRef(profile);
  profileRef.current = profile;

  React.useEffect(() => {
    let recording: WorkbenchSample[] | null = null;
    let marks: Array<{ event: string; t: number }> = [];
    let sampled: HTMLElement[] = [];
    let reach: number[] = [];
    let frame = 0;
    const unsubscribe = subscribeWorkbenchProfileTransition((state) => {
      const last = marks.at(-1);
      const event = state.retiring ? 'retiring' : state.phase;
      if (last?.event !== event) marks.push({ event, t: performance.now() });
    });
    const sampleCells = () => {
      const cells = [...document.querySelectorAll<HTMLElement>('.wb-lattice-field > i')];
      if (cells.length === 0 || (sampled.length > 0 && sampled[0]!.isConnected)) return;
      const switcher = document.querySelector('[data-varin-workbench-switcher]')!.getBoundingClientRect();
      const ox = switcher.left + switcher.width / 2;
      const oy = switcher.top + switcher.height / 2;
      const stride = Math.max(1, Math.floor(cells.length / 80));
      const chosen = cells.filter((_, index) => index % stride === 0)
        .map(cell => ({ cell, d: Math.hypot(cell.offsetLeft + cell.offsetWidth / 2 - ox, cell.offsetTop + cell.offsetHeight / 2 - oy) }))
        .sort((a, b) => a.d - b.d);
      sampled = chosen.map(entry => entry.cell);
      const farthest = chosen.at(-1)?.d || 1;
      reach = chosen.map(entry => entry.d / farthest);
    };
    const sample = () => {
      if (recording) {
        sampleCells();
        const hold = document.querySelector<HTMLElement>('.wb-lattice-hold');
        const sheet = document.querySelector<HTMLElement>('.wb-lattice-sheet');
        recording.push({
          t: performance.now(),
          phase: document.querySelector<HTMLElement>('[data-lab-overlay]')?.dataset.labOverlay ?? 'idle',
          layout: document.querySelector<HTMLElement>('[data-lab-layout]')?.dataset.labLayout ?? null,
          scales: sampled.filter(cell => cell.isConnected).map(cell => new DOMMatrixReadOnly(getComputedStyle(cell).transform).a),
          hold: hold ? Number(getComputedStyle(hold).opacity) : 0,
          sheet: sheet && getComputedStyle(sheet).display !== 'none' ? Number(getComputedStyle(sheet).opacity) : null,
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      record() { recording = []; marks = []; sampled = []; },
      stopRecording() {
        const result = { frames: recording ?? [], marks, reach };
        recording = null;
        return result;
      },
      async go(next: Profile, options: { holdMs?: number } = {}) {
        const from = profileRef.current;
        if (next === from) return;
        const id = beginWorkbenchProfileTransition({
          direction: PROFILES.indexOf(next) >= PROFILES.indexOf(from) ? 'forward' : 'backward',
          fromProfileId: from,
          reducedMotion: prefersReducedMotion(),
          scene: CAPTURE,
          toProfileId: next,
        });
        if (!options.holdMs) markWorkbenchProfileTransitionOperationPrepared(id);
        if (!await waitForWorkbenchProfileTransitionCovered(id)) return;
        if (options.holdMs) await sleep(options.holdMs);
        flushSync(() => setProfile(next));
        marks.push({ event: 'commit', t: performance.now() });
        await nextPaint();
        await revealWorkbenchProfileTransition(id);
      },
    };
    (window as unknown as { __wb: typeof lab }).__wb = lab;
    return () => { cancelAnimationFrame(frame); unsubscribe(); };
  }, []);

  return <div className="flex h-full flex-col bg-background text-foreground">
    <TitleBar profile={profile} />
    {profile === 'ide' ? <IdeShell /> : <WorkbenchShell />}
    <LabTransitionOverlay />
  </div>;
}
