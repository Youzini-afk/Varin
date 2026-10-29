const phase = new URLSearchParams(window.location.search).get('stool');
if (new URLSearchParams(window.location.search).get('scene') === '1') {
  const { mountCompanionScene } = await import('@varin/ui/components/companion/sceneRenderer');
  const root = document.getElementById('root');
  if (root) mountCompanionScene(root);
} else if (phase === 'lift' || phase === 'landing') {
  // Decorative native surface: no RuntimeAPIs, Host subscription or desktop preload.
  const root = document.getElementById('root');
  if (root) {
    const image = document.createElement('img');
    image.alt = ''; image.draggable = false;
    image.style.opacity = phase === 'landing' ? '0' : '1';
    image.style.cssText += 'display:block;width:100vw;height:100vh;object-fit:fill;pointer-events:none';
    let nativeVisible = false, started = false;
    const start = () => {
      if (!nativeVisible || !image.complete || !image.naturalWidth || started) return;
      started = true;
      image.animate(phase === 'lift' ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], { duration: phase === 'lift' ? 150 : 100, fill: 'forwards' });
    };
    image.onload = start;
    window.addEventListener('varin-stool-visible', () => { nativeVisible = true; start(); }, { once: true });
    image.src = new URL('./companion-assets/stool.png', window.location.href).toString();
    root.append(image);
  }
} else {
  const [{ createConfiguredWebAPIs }, { renderCompanionApp }] = await Promise.all([
    import('./runtimeConfig'), import('@varin/ui/apps/renderCompanionApp'),
  ]);
  renderCompanionApp(createConfiguredWebAPIs());
}
export {};
