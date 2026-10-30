import { readCompanionWorldPlate, verifyCompanionWorldPlate } from './companionWorldPlate';
import { companionAssetBase } from '@varin/application-client';

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
    image.onload = () => {
      document.documentElement.dataset.varinCompanionStoolReady = 'true';
      window.dispatchEvent(new Event('varin-companion-stool-ready'));
      start();
    };
    window.addEventListener('varin-stool-visible', () => { nativeVisible = true; start(); }, { once: true });
    // Read the same installed bundle as the character, never a renderer-provided URL.
    // New epochs use immutable hash-named plates, so an old decorative cache cannot
    // silently show a different identity's stool after an atomic bundle replacement.
    void (async () => {
      const base = new URL(companionAssetBase(window.location.href), window.location.href);
      const response = await fetch(new URL('bundle.json', base));
      if (!response.ok) throw new Error('Companion bundle unavailable');
      const bundle = await response.json();
      const plate = readCompanionWorldPlate(bundle);
      const result = await fetch(new URL(plate.file, base));
      if (!result.ok) throw new Error('Companion world plate unavailable');
      const bytes = await result.arrayBuffer();
      await verifyCompanionWorldPlate(bytes, plate.sha256);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      window.addEventListener('pagehide', () => URL.revokeObjectURL(objectUrl), { once: true });
      image.src = objectUrl;
    })().catch(error => { console.error('[companion] decorative plate failed', error); });
    root.append(image);
  }
} else {
  const [{ createConfiguredWebAPIs }, { renderCompanionApp }] = await Promise.all([
    import('./runtimeConfig'), import('@varin/ui/apps/renderCompanionApp'),
  ]);
  renderCompanionApp(createConfiguredWebAPIs());
}
export {};
