import React from 'react';

/** Form on the left, a live example on the right; on narrow canvases the example sits above the form and can be folded. */
export function PreviewLayout({ preview, children }: { preview: React.ReactNode; children: React.ReactNode }) {
  return <div className="sk-pv-layout">
    <div className="sk-pv-form">{children}</div>
    <aside className="sk-pv-side">{preview}</aside>
  </div>;
}

const bar = (width: number, opacity = 0.18) => <i style={{ display: 'block', height: 5, borderRadius: 3, background: 'currentColor', opacity, width: `${width}%`, margin: '5px 0' }} />;
const fold = <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '6px 0', opacity: 0.5 }}>
  <i style={{ width: 6, height: 6, borderRight: '1.5px solid', borderBottom: '1.5px solid', transform: 'rotate(-45deg)' }} />
  <i style={{ flex: 'none', width: '40%', height: 4, borderRadius: 3, background: 'currentColor', opacity: 0.4 }} />
</div>;

/** Thumbnails for the three reply layouts. */
export function ReadingArt({ kind }: { kind: 'dialogue' | 'live' | 'sorted' }) {
  return <div style={{ position: 'absolute', inset: 0, padding: '10px 14px', color: 'var(--sk-fg)' }}>
    {kind === 'dialogue' ? <>{bar(80, 0.35)}{fold}{bar(65, 0.35)}{fold}{bar(50, 0.35)}</>
      : kind === 'live' ? <>{bar(80, 0.35)}{bar(70)}{bar(74)}{bar(60, 0.35)}{bar(66)}{bar(55)}</>
        : <><div style={{ borderRadius: 4, background: 'currentColor', opacity: 0.08, height: 16, margin: '4px 0 8px' }} />{bar(85, 0.35)}{bar(78, 0.35)}{bar(60, 0.35)}</>}
  </div>;
}

/** Thumbnail of a color mode drawn with the actual theme surfaces. */
export function ModeArt({ background, sidebar, foreground, accent, split }: { background: string; sidebar: string; foreground: string; accent: string; split?: { background: string; sidebar: string; foreground: string } }) {
  const surface = split ? `linear-gradient(105deg, ${background} 50%, ${split.background} 50%)` : background;
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', background: surface }}>
    <div style={{ width: '26%', margin: '8px 0 8px 8px', borderRadius: 5, background: split ? `linear-gradient(105deg, ${sidebar} 60%, ${split.sidebar} 60%)` : sidebar, opacity: 0.95 }} />
    <div style={{ flex: 1, padding: '12px 12px', color: split ? `color-mix(in srgb, ${foreground} 50%, ${split.foreground})` : foreground }}>
      {bar(70, 0.3)}{bar(52)}{bar(60)}
      <i style={{ display: 'block', marginTop: 9, height: 12, borderRadius: 4, background: accent, opacity: 0.6, width: '40%' }} />
    </div>
  </div>;
}
