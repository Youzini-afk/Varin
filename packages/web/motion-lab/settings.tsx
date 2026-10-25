import React from 'react';
import { SettingsView } from '@/components/views/SettingsView';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useUIStore } from '@/stores/useUIStore';
import { registerBuiltinSettingsWorkbench } from '@/workbenches/settings/register';

/**
 * Settings scene: the real settings view as the window shows it, with the
 * built-in pages registered and no Host. `window.__settings` opens pages and
 * records the navigation pill, the breadcrumb and the page frame by frame.
 */

const inert = (): unknown => {
  const children = new Map<PropertyKey, unknown>();
  return new Proxy(() => Promise.resolve(undefined), {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (!children.has(key)) children.set(key, inert());
      return children.get(key);
    },
  });
};
const inertApis = inert() as React.ContextType<typeof RuntimeAPIContext>;

interface SettingsSample {
  t: number;
  pill: { top: number; opacity: number } | null;
  current: { slug: string; top: number } | null;
  leaving: { opacity: number; y: number } | null;
  crumb: { current: number; leaving: number | null };
  parts: number[];
}

export function SettingsLab() {
  React.useState(() => {
    registerBuiltinSettingsWorkbench();
    useUIStore.setState({ settingsPage: 'general' } as never);
  });
  React.useEffect(() => {
    let recording: SettingsSample[] | null = null;
    let frame = 0;
    const sample = () => {
      if (recording) {
        const nav = document.querySelector<HTMLElement>('[data-settings-nav-pill]');
        const pill = nav?.querySelector<HTMLElement>('.settings-nav-pill');
        const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
        const leaving = document.querySelector<HTMLElement>('[data-settings-leaving]');
        const crumb = [...document.querySelectorAll<HTMLElement>('[data-settings-breadcrumb] .swap-text')].at(-1);
        const page = [...document.querySelectorAll<HTMLElement>('[data-settings-page]')].find(node => !node.closest('[data-settings-leaving]'));
        recording.push({
          t: performance.now(),
          pill: pill ? { top: pill.getBoundingClientRect().top, opacity: Number(getComputedStyle(pill).opacity) } : null,
          current: current ? { slug: current.textContent ?? '', top: current.getBoundingClientRect().top } : null,
          leaving: leaving ? { opacity: Number(getComputedStyle(leaving).opacity), y: new DOMMatrixReadOnly(getComputedStyle(leaving).transform).m42 } : null,
          crumb: { current: crumb?.querySelector('.swap-text-current')?.getBoundingClientRect().top ?? 0, leaving: crumb?.querySelector('[data-swap-leaving]')?.getBoundingClientRect().top ?? null },
          parts: page ? [...page.children].slice(0, 4).map(part => Number(getComputedStyle(part).opacity)) : [],
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      open(slug: string) { useUIStore.getState().setSettingsPage(slug as never); },
    };
    (window as unknown as { __settings: typeof lab }).__settings = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  return <RuntimeAPIContext.Provider value={inertApis}>
    <div className="flex h-full items-center justify-center bg-background p-6 text-foreground">
      <div className="h-[640px] w-[1000px] overflow-hidden rounded-xl border border-border">
        <SettingsView isWindowed animateEntrance />
      </div>
    </div>
  </RuntimeAPIContext.Provider>;
}
