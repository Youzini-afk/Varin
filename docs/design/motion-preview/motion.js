/* Varin 动效原型 · 运动引擎
 * - 四个弹簧 token（snap / glide / travel / settle）→ CSS linear() 曲线 + JS 采样曲线
 * - 可打断、带速度的 JS 弹簧（选中胶囊、滚动跟随、分段控件滑块）
 * - 时间缩放（慢放）与动效级别（完整 / 简化 / 关闭）
 * - FLIP、尾部 FLIP 尺寸变化、标签换字、数字滚动
 */
(function () {
  'use strict';
  const root = document.documentElement;
  const media = matchMedia('(prefers-reduced-motion: reduce)');

  const M = {
    ts: 1,
    level: media.matches ? 'reduced' : 'full',
    legacy: false,
    ease: {},
    dur: {},
    curve: {},
    springs: {},
  };

  const SPRINGS = {
    snap: { bounce: 0, visualDuration: 0.18 },
    glide: { bounce: 0, visualDuration: 0.32 },
    travel: { bounce: 0.06, visualDuration: 0.5 },
    settle: { bounce: 0.3, visualDuration: 0.42 },
  };

  // 与 motion 的 visualDuration/bounce 换算一致：mass = 1
  function springCoefficients(cfg) {
    const bounce = cfg.bounce || 0;
    const visualDuration = cfg.visualDuration || 0.32;
    const r = (2 * Math.PI) / (visualDuration * 1.2);
    const stiffness = r * r;
    const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
    return { stiffness, damping: 2 * zeta * Math.sqrt(stiffness) };
  }

  function sampleSpring(coef) {
    const h = 0.001;
    let x = 0;
    let v = 0;
    let t = 0;
    const xs = [0];
    while (t < 3) {
      v += (-coef.stiffness * (x - 1) - coef.damping * v) * h;
      x += v * h;
      t += h;
      xs.push(x);
      if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.03) break;
    }
    xs[xs.length - 1] = 1;
    return { xs, duration: t };
  }

  function curveFrom(xs) {
    const n = xs.length - 1;
    return (p) => {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      const f = p * n;
      const i = Math.floor(f);
      return xs[i] + (xs[i + 1] - xs[i]) * (f - i);
    };
  }

  function linearEasing(xs) {
    const n = xs.length - 1;
    const points = Math.min(64, Math.max(24, Math.round(n / 12)));
    const out = [];
    for (let i = 0; i <= points; i++) out.push(+xs[Math.round((i / points) * n)].toFixed(4));
    return `linear(${out.join(', ')})`;
  }

  const supportsLinear = !!(window.CSS && CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)'));
  const FALLBACK = {
    snap: ['cubic-bezier(.22,1,.36,1)', 200],
    glide: ['cubic-bezier(.22,1,.36,1)', 340],
    travel: ['cubic-bezier(.22,1,.36,1)', 520],
    settle: ['cubic-bezier(.34,1.32,.64,1)', 460],
  };

  for (const [name, cfg] of Object.entries(SPRINGS)) {
    const coef = springCoefficients(cfg);
    const { xs, duration } = sampleSpring(coef);
    M.springs[name] = Object.assign({}, cfg, coef, { settleMs: Math.round(duration * 1000) });
    M.curve[name] = curveFrom(xs);
    if (supportsLinear) {
      M.ease[name] = linearEasing(xs);
      M.dur[name] = Math.round(duration * 1000);
    } else {
      M.ease[name] = FALLBACK[name][0];
      M.dur[name] = FALLBACK[name][1];
    }
    root.style.setProperty(`--ease-${name}`, M.ease[name]);
    root.style.setProperty(`--dur-${name}`, `${M.dur[name]}ms`);
  }
  M.ease.out = 'cubic-bezier(.22,1,.36,1)';
  M.ease.exit = 'cubic-bezier(.4,0,1,1)';
  M.dur.fade = 160;
  M.dur.exit = 110;
  M.supportsLinear = supportsLinear;

  M.setTimeScale = (ts) => {
    M.ts = ts;
    root.style.setProperty('--ts', String(ts));
  };
  M.setLevel = (level) => {
    M.level = level;
    root.dataset.motion = level;
  };
  M.setLegacy = (on) => {
    M.legacy = on;
    root.classList.toggle('legacy', on);
  };
  root.dataset.motion = M.level;

  // ---------- WAAPI 包装：时间缩放 + 动效级别 ----------
  const RESOLVED = Object.freeze({ finished: Promise.resolve(), cancel() {}, finish() {}, playState: 'finished' });
  const MOTION_PROPS = ['transform', 'translate', 'scale', 'rotate', 'clipPath', 'filter'];

  M.animate = (el, keyframes, opts = {}) => {
    if (!el) return RESOLVED;
    let duration = opts.duration ?? M.dur.glide;
    let easing = opts.easing ?? M.ease.glide;
    let delay = opts.delay ?? 0;
    if (opts.spring) {
      easing = M.ease[opts.spring];
      duration = M.dur[opts.spring];
    }
    if (M.level === 'off') return RESOLVED;
    if (M.level === 'reduced') {
      keyframes = keyframes.map((k) => {
        const o = Object.assign({}, k);
        MOTION_PROPS.forEach((p) => delete o[p]);
        return o;
      });
      const hasProps = keyframes.some((k) => Object.keys(k).some((p) => p !== 'offset' && p !== 'easing' && p !== 'composite'));
      if (!hasProps) return RESOLVED;
      duration = Math.min(duration, 160);
      easing = 'ease-out';
      delay = Math.min(delay, 60);
    }
    const timing = { duration: duration * M.ts, delay: delay * M.ts, easing, fill: opts.fill || 'backwards' };
    if (opts.composite) timing.composite = opts.composite;
    if (opts.pseudoElement) timing.pseudoElement = opts.pseudoElement;
    return el.animate(keyframes, timing);
  };
  M.done = (anim) => (anim && anim.finished ? anim.finished.catch(() => {}) : Promise.resolve());

  // ---------- 可取消的运行（重播 / 停止） ----------
  class Cancelled extends Error {
    constructor() {
      super('cancelled');
      this.name = 'Cancelled';
    }
  }
  M.Cancelled = Cancelled;
  M.createRun = () => {
    const subs = new Set();
    return {
      cancelled: false,
      onCancel(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        subs.forEach((f) => f());
        subs.clear();
      },
      check() {
        if (this.cancelled) throw new Cancelled();
      },
    };
  };
  M.sleep = (ms, run) =>
    new Promise((resolve, reject) => {
      if (run && run.cancelled) return reject(new Cancelled());
      let off = null;
      const id = setTimeout(() => {
        if (off) off();
        resolve();
      }, ms * M.ts);
      if (run) {
        off = run.onCancel(() => {
          clearTimeout(id);
          reject(new Cancelled());
        });
      }
    });

  // ---------- 帧循环 + 弹簧 ----------
  const springsActive = new Set();
  const frameFns = new Set();
  let rafId = 0;
  let lastT = 0;
  function loop(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)) / M.ts;
    lastT = now;
    springsActive.forEach((s) => s._step(dt));
    frameFns.forEach((fn) => fn(dt, now));
    rafId = springsActive.size || frameFns.size ? requestAnimationFrame(loop) : 0;
  }
  function wake() {
    if (!rafId) {
      lastT = performance.now();
      rafId = requestAnimationFrame(loop);
    }
  }
  M.onFrame = (fn) => {
    frameFns.add(fn);
    wake();
    return () => frameFns.delete(fn);
  };

  class Spring {
    constructor(value, opts = {}) {
      this.x = value;
      this.v = 0;
      this.target = value;
      this.restDelta = opts.restDelta ?? 0.1;
      this.restSpeed = opts.restSpeed ?? 2;
      this.onUpdate = opts.onUpdate || (() => {});
      this.configure(opts);
    }
    configure(opts = {}) {
      if (opts.omega) {
        this.k = opts.omega * opts.omega;
        this.c = 2 * (opts.zeta ?? 1) * opts.omega;
      } else {
        const c = springCoefficients(SPRINGS[opts.token] || opts);
        this.k = c.stiffness;
        this.c = c.damping;
      }
      return this;
    }
    get active() {
      return springsActive.has(this);
    }
    to(target, { instant = false } = {}) {
      this.target = target;
      if (instant || M.level !== 'full') return this.jump(target);
      springsActive.add(this);
      wake();
    }
    jump(value) {
      this.x = this.target = value;
      this.v = 0;
      springsActive.delete(this);
      this.onUpdate(value);
    }
    stop() {
      springsActive.delete(this);
      this.v = 0;
      this.target = this.x;
    }
    sync(value) {
      if (!this.active) {
        this.x = this.target = value;
        this.v = 0;
      }
    }
    _step(dt) {
      const n = Math.max(1, Math.ceil(dt / 0.004));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
        this.x += this.v * h;
      }
      if (Math.abs(this.x - this.target) < this.restDelta && Math.abs(this.v) < this.restSpeed) {
        this.x = this.target;
        this.v = 0;
        springsActive.delete(this);
      }
      this.onUpdate(this.x);
    }
  }
  M.Spring = Spring;

  // ---------- FLIP：布局一次提交，transform 负责过渡 ----------
  M.flip = (els, mutate, opts = { spring: 'glide' }) => {
    els = els.filter(Boolean);
    const first = els.map((e) => e.getBoundingClientRect());
    els.forEach((e) => e._flip && e._flip.cancel());
    mutate();
    if (M.legacy) return;
    els.forEach((e, i) => {
      const last = e.getBoundingClientRect();
      const dx = first[i].left - last.left;
      const dy = first[i].top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      e._flip = M.animate(e, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], opts);
    });
  };

  function followingRows(el, stop) {
    const out = [];
    for (let n = el; n && n !== stop && n.parentElement; n = n.parentElement) {
      for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
        if (!s.classList.contains('m-ghost')) out.push(s);
      }
      if (n.parentElement === stop) break;
    }
    return out;
  }

  // 尾部 FLIP：高度只提交一次；旧外观用快照淡出，下方行用 transform 补偿。
  // 对应生产方案「measure once + tail FLIP」，避免虚拟列表逐帧重测高度。
  M.resize = (el, mutate, opts = {}) => {
    const stop = opts.stop || el.closest('.timeline') || el.parentElement;
    const spring = opts.spring || 'glide';
    if (M.legacy || M.level === 'off' || !el.isConnected) {
      mutate();
      return Promise.resolve();
    }
    const h0 = el.offsetHeight;
    let ghost = null;
    if (opts.crossfade !== false) {
      ghost = el.cloneNode(true);
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      ghost.classList.add('m-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      Object.assign(ghost.style, {
        position: 'absolute',
        left: `${el.offsetLeft}px`,
        top: `${el.offsetTop}px`,
        width: `${el.offsetWidth}px`,
        height: `${h0}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '1',
      });
    }
    mutate();
    const h1 = el.offsetHeight;
    const d = h1 - h0;
    const tail = followingRows(el, stop);
    if (ghost) el.after(ghost);
    const anims = [];
    if (d > 0) anims.push(M.animate(el, [{ clipPath: `inset(0 0 ${d}px 0)` }, { clipPath: 'inset(0 0 0 0)' }], { spring }));
    if (ghost) {
      if (d < 0) {
        anims.push(
          M.animate(ghost, [{ clipPath: 'inset(0 0 0 0)', opacity: 1 }, { clipPath: `inset(0 0 ${-d}px 0)`, opacity: 0 }], {
            spring,
            fill: 'forwards',
          }),
        );
      } else {
        anims.push(M.animate(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: M.ease.exit, fill: 'forwards' }));
      }
      M.animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 40, easing: M.ease.out });
    }
    if (Math.abs(d) >= 1) {
      tail.forEach((r) =>
        anims.push(M.animate(r, [{ transform: `translateY(${-d}px)` }, { transform: 'translateY(0)' }], { spring, composite: 'add' })),
      );
    }
    return Promise.all(anims.map(M.done)).then(() => ghost && ghost.remove());
  };

  // ---------- 标签换字：同格叠放，旧字上移淡出，新字自下进入 ----------
  M.swapText = (host, text, { dir = 1, width = false } = {}) => {
    const cur = host.querySelector(':scope > .swap-cur');
    if (cur && cur.textContent === text) return;
    if (!cur || M.legacy || M.level === 'off') {
      host.replaceChildren();
      const s = document.createElement('span');
      s.className = 'swap-cur';
      s.textContent = text;
      host.append(s);
      return;
    }
    const w0 = host.offsetWidth;
    host.querySelectorAll(':scope > .swap-old').forEach((n) => n.remove());
    cur.className = 'swap-old';
    const next = document.createElement('span');
    next.className = 'swap-cur';
    next.textContent = text;
    host.append(next);
    const out = M.animate(cur, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-6 * dir}px)` }], {
      duration: M.dur.exit,
      easing: M.ease.exit,
      fill: 'forwards',
    });
    M.done(out).then(() => cur.remove());
    M.animate(next, [{ opacity: 0, transform: `translateY(${6 * dir}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 30 });
    if (width) {
      const w1 = next.offsetWidth;
      if (Math.abs(w1 - w0) > 1) M.animate(host, [{ width: `${w0}px` }, { width: `${w1}px` }], { spring: 'glide' });
    }
  };

  // ---------- 数字滚动 ----------
  M.countTo = (el, to, { from = 0, duration = 600, format = (n) => String(Math.round(n)) } = {}) => {
    if (M.level !== 'full' || M.legacy) {
      el.textContent = format(to);
      return;
    }
    const start = performance.now();
    const D = duration * M.ts;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / D);
      el.textContent = format(from + (to - from) * M.curve.glide(p));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  window.VarinMotion = M;
})();
