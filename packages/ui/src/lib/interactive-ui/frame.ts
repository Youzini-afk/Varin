// Runs inside an opaque sandbox. No Host endpoint, credential, or parent DOM is supplied.
function frameRuntime() {
  const channel = document.documentElement.dataset.channel!;
  const send = (value: object) => parent.postMessage({ channel, ...value }, '*');
  let state: unknown = null, context: unknown = null, ready = false, displayedSource: unknown;
  let renderState = 'preview';
  let savedControls: Record<string, unknown> = {}, savedScroll = { x: 0, y: 0 };
  const assets: string[] = [];
  const assetCache = new Map<string, { text: string; url: string }>();
  let currentFiles: Record<string, string> = {}, currentEntry = 'index.html';
  const originalFetch = window.fetch.bind(window);
  let resolveFile: (from: string, ref: string) => string = (_from, ref) => ref;
  window.fetch = (input, options) => originalFetch(typeof input === 'string' ? resolveFile(currentEntry, input) : input, options);
  const dom = () => document.getElementById('work')!;
  const key = (node: Element) => node.id || node.getAttribute('data-key');
  const sync = (target: Element, incoming: Element) => {
    for (const attribute of [...target.attributes]) if (!incoming.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
    for (const attribute of [...incoming.attributes]) if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
    const existing = new Map([...target.children].filter(node => key(node)).map(node => [key(node), node]));
    let cursor: ChildNode | null = target.firstChild;
    [...incoming.childNodes].forEach(next => {
      let current: ChildNode | undefined | null = next instanceof Element && key(next) ? existing.get(key(next)) : cursor?.nodeType === next.nodeType ? cursor : null;
      if (current instanceof Element && next instanceof Element && current.tagName === next.tagName) sync(current, next);
      else if (current?.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) { if (current.textContent !== next.textContent) current.textContent = next.textContent; }
      else current = next.cloneNode(true) as ChildNode;
      if (current !== cursor) target.insertBefore(current!, cursor);
      cursor = current!.nextSibling;
    });
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  };
  const selector = (element: Element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = []; let node: Element | null = element;
    while (node && node !== dom()) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(item => item.tagName === node!.tagName) : [];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`); node = node.parentElement;
    }
    return `#work > ${parts.join(' > ')}`;
  };
  const currentState = () => ({ data: state, scroll: { x: scrollX, y: scrollY }, controls: Object.fromEntries([...dom().querySelectorAll('input,select,textarea')].map(element => {
    const input = element as HTMLInputElement; return [selector(element), input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value];
  })) });
  const observation = () => ({ source: displayedSource, state: currentState(), context, render: { state: renderState }, capturedAt: new Date().toISOString(),
    structure: [...dom().querySelectorAll('*')].flatMap(element => {
      const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element);
      if (!bounds.width || !bounds.height || bounds.bottom < 0 || bounds.top > innerHeight || bounds.right < 0 || bounds.left > innerWidth || style.visibility === 'hidden') return [];
      const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
      const input = element as HTMLInputElement;
      const value = 'value' in element ? input.type === 'checkbox' || input.type === 'radio' ? String(input.checked) : String(input.value) : undefined;
      if (!text && value === undefined && !['CANVAS', 'IMG', 'BUTTON'].includes(element.tagName)) return [];
      return [{ tag: element.tagName.toLowerCase(), text, value, selector: selector(element), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }];
    }), viewport: { width: innerWidth, height: innerHeight }, ready });
  const raster = async () => {
    const clone = dom().cloneNode(true) as HTMLElement;
    const originals = [dom(), ...dom().querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((element, index) => {
      const copy = copies[index] as HTMLElement;
      const style = getComputedStyle(element);
      for (const property of style) copy.style.setProperty(property, style.getPropertyValue(property));
      for (const attribute of [...copy.attributes]) if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name);
      if (element instanceof HTMLCanvasElement) { try { const image = document.createElement('img'); image.src = element.toDataURL(); image.style.cssText = copy.style.cssText; copy.replaceWith(image); } catch { copy.textContent = '[Canvas pixels unavailable]'; } }
      if (element instanceof HTMLInputElement) copy.setAttribute('value', element.value);
    });
    clone.querySelectorAll('script,style,link').forEach(element => element.remove());
    const markup = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${innerWidth}" height="${innerHeight}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="transform:translate(${-scrollX}px,${-scrollY}px)">${markup}</div></foreignObject></svg>`;
    const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], method: 'dom', capturedAt: new Date().toISOString() };
  };
  let saveFrame = 0;
  const save = () => { cancelAnimationFrame(saveFrame); saveFrame = requestAnimationFrame(() => send({ type: 'state', state: currentState() })); };
  Object.defineProperty(window, 'varinUI', { value: Object.freeze({ get state() { return state; },
    saveState(value: unknown) { state = JSON.parse(JSON.stringify(value)); save(); },
    setContext(value: unknown) { context = JSON.parse(JSON.stringify(value)); },
  }), configurable: false });
  const restore = () => {
    for (const [path, value] of Object.entries(savedControls)) {
      const element = document.querySelector(path) as HTMLInputElement | null;
      if (!element) continue;
      if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scrollTo(savedScroll.x, savedScroll.y);
  };
  const update = async (message: { files: Record<string, string>; assets?: Record<string, { mimeType: string; data: string }>; entry: string; committed: boolean; source: unknown; state?: ReturnType<typeof currentState> }) => {
    renderState = message.committed ? 'loading' : 'preview';
    if (message.state) { state = message.state.data; savedControls = message.state.controls; savedScroll = message.state.scroll; }
    const html = message.files[message.entry] ?? '';
    currentFiles = message.files; currentEntry = message.entry;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const scripts = [...parsed.querySelectorAll('script')].map(script => ({ text: script.textContent ?? '', src: script.getAttribute('src'), type: script.getAttribute('type'), attributes: [...script.attributes].map(attr => [attr.name, attr.value] as const) }));
    parsed.querySelectorAll('script,base').forEach(node => node.remove());
    if (!message.committed) {
      parsed.querySelectorAll('iframe,object,embed,meta[http-equiv]').forEach(node => node.remove());
      for (const element of parsed.querySelectorAll('*')) for (const attr of [...element.attributes]) if (/^on/i.test(attr.name) || /^(?:href|src|action)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
    }
    const resolve = (from: string, ref: string) => {
      const media = message.assets?.[ref];
      if (media) return `data:${media.mimeType};base64,${media.data}`;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return ref;
      const segments = ref.startsWith('/') ? [] : from.split('/').slice(0, -1);
      const [pathname] = ref.split(/[?#]/, 1);
      for (const part of pathname!.split('/')) {
        if (part === '..') { if (!segments.length) return ref; segments.pop(); }
        else if (part !== '.' && part) { try { segments.push(decodeURIComponent(part)); } catch { segments.push(part); } }
      }
      const path = segments.join('/');
      if (!Object.hasOwn(currentFiles, path)) return ref;
      const type = /\.css$/i.test(path) ? 'text/css' : /\.[cm]?js$/i.test(path) ? 'text/javascript' : /\.json$/i.test(path) ? 'application/json' : 'text/plain';
      let text = currentFiles[path]!;
      if (type === 'text/css') text = text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (_, quote: string, url: string) => `url(${quote}${resolve(path, url)}${quote})`);
      const previous = assetCache.get(path); if (previous?.text === text) return previous.url;
      const url = URL.createObjectURL(new Blob([text], { type })); assetCache.set(path, { text, url });
      if (previous) requestAnimationFrame(() => URL.revokeObjectURL(previous.url));
      return url;
    };
    resolveFile = resolve;
    parsed.querySelectorAll('link[href],img[src],source[src],audio[src],video[src]').forEach(element => {
      const attr = element.hasAttribute('href') ? 'href' : 'src'; element.setAttribute(attr, resolve(message.entry, element.getAttribute(attr)!));
    });
    for (const attribute of [...document.body.attributes]) if (!parsed.body.hasAttribute(attribute.name)) document.body.removeAttribute(attribute.name);
    for (const attribute of [...parsed.body.attributes]) document.body.setAttribute(attribute.name, attribute.value);
    const incoming = document.createElement('div'); incoming.id = 'work';
    incoming.append(...parsed.head.childNodes, ...parsed.body.childNodes);
    sync(dom(), incoming);
    displayedSource = message.source;
    if (message.committed) {
      const imports: Record<string, string> = { d3: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm', 'chart.js/auto': 'https://cdn.jsdelivr.net/npm/chart.js@4.4.8/auto/+esm' };
      for (const [file] of Object.entries(message.files)) if (/\.[cm]?js$|\.json$/i.test(file)) imports[`ui-file:/${file.split('/').map(encodeURIComponent).join('/')}`] = resolve('', file);
      for (const spec of scripts.filter(spec => spec.type === 'importmap')) Object.assign(imports, JSON.parse(spec.text).imports ?? {});
      const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({ imports }); document.head.append(map);
      for (const spec of scripts) {
        if (spec.type === 'importmap') continue;
        const script = document.createElement('script');
        for (const [name, value] of spec.attributes) if (name !== 'src') script.setAttribute(name, value);
        if (spec.src) { script.src = resolve(message.entry, spec.src); script.async = false; }
        else if (spec.type === 'module') { const url = URL.createObjectURL(new Blob([spec.text], { type: 'text/javascript' })); assets.push(url); script.src = url; }
        else script.textContent = spec.text;
        const loaded = spec.src || spec.type === 'module' ? new Promise<void>(resolve => { script.onload = () => resolve(); script.onerror = () => { renderState = 'error'; send({ type: 'error', message: '脚本加载失败' }); resolve(); }; }) : null;
        dom().append(script);
        if (loaded) await loaded;
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => { restore(); resolve(); }));
      ready = true;
      if (renderState !== 'error') renderState = 'ready';
    }
    send({ type: 'updated', height: dom().scrollHeight });
  };
  let updates = Promise.resolve();
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.type === 'update') updates = updates.then(() => update(message)).catch(error => { renderState = 'error'; send({ type: 'error', message: String(error) }); });
    else if (message.type === 'theme') document.getElementById('theme')!.textContent = message.css;
    else if (message.type === 'capture') {
      const value = observation();
      if (message.raster) void raster().then(image => send({ type: 'capture', id: message.id, ...value, image }), error => send({ type: 'capture-error', id: message.id, error: String(error) }));
      else send({ type: 'capture', id: message.id, ...value });
    } else if (message.type === 'reset') { state = null; savedControls = {}; savedScroll = { x: 0, y: 0 }; location.reload(); }
  });
  addEventListener('input', save); addEventListener('change', save); addEventListener('scroll', save, { passive: true });
  addEventListener('mouseup', () => {
    const selection = getSelection(); if (!selection || !selection.toString().trim()) return;
    const range = selection.getRangeAt(0);
    const endpoint = (node: Node, offset: number) => ({ selector: selector(node instanceof Element ? node : node.parentElement!),
      ...(node instanceof Element ? {} : { childIndex: [...node.parentNode!.childNodes].indexOf(node as ChildNode) }), offset });
    send({ type: 'selection', ...observation(), text: selection.toString(), textRange: { start: endpoint(range.startContainer, range.startOffset), end: endpoint(range.endContainer, range.endOffset) } });
  });
  addEventListener('error', () => { renderState = 'error'; send({ type: 'error', message: '页面运行出错，可查看源码继续修改' }); });
  addEventListener('unhandledrejection', () => { renderState = 'error'; send({ type: 'error', message: '页面运行出错，可查看源码继续修改' }); });
  new ResizeObserver(() => send({ type: 'resize', height: dom().scrollHeight })).observe(dom());
  send({ type: 'ready' });
}
export function uiFrameDocument(channel: string) {
  return `<!doctype html><html data-channel="${channel}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="https://varin.invalid/"><style id="theme"></style><style>html{color-scheme:light dark}body{margin:0;padding:16px;font:14px/1.55 system-ui}*{box-sizing:border-box}img,canvas,svg{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}a{color:var(--primary)}:focus-visible{outline:2px solid var(--primary);outline-offset:2px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}</style></head><body><div id="work"></div><script>(${frameRuntime.toString()})()</script></body></html>`;
}
export function uiThemeCss() {
  const computed = getComputedStyle(document.documentElement);
  const vars = ['background', 'foreground', 'muted', 'muted-foreground', 'primary', 'primary-foreground', 'border', 'card', 'card-foreground'].map(name => `--${name}:${computed.getPropertyValue(`--${name}`)};`).join('');
  return `:root{${vars}color-scheme:${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}}body{background:var(--background);color:var(--foreground);font-family:${getComputedStyle(document.body).fontFamily}}`;
}
