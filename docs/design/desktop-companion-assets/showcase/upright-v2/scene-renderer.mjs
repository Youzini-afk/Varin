// varin-main-20261028/packages/ui/src/components/companion/sceneGeometry.ts
var COMPANION_SCENE_GEOMETRY = {
  id: "upright-v2-scene-layout",
  character: { x: 50, y: 25, width: 200, height: 200 },
  protectedFace: { x: 82, y: 18, width: 134, height: 90 },
  computerLeft: { x: 104, y: 146 },
  computerRight: { x: 166, y: 147 },
  artworkExtent: { left: 9, right: 285 }
};

// varin-main-20261028/packages/ui/src/components/companion/sceneRenderer.ts
var blue = "#6587ac";
var ink = "#50657e";
var cyan = "#73b6bf";
var purple = "#a394c3";
var gold = "#d2aa67";
var peach = "#ce9997";
var path = (d, c = blue, fill = "none", width = 2) => `<path d="${d}" stroke="${c}" fill="${fill}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
var dot = (x, y, c = cyan, r = 3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
var page = (x, y, w = 42, h = 52, c = blue) => path(`M${x + 2} ${y} L${x + w - 9} ${y + 1} L${x + w} ${y + 10} L${x + w - 1} ${y + h} L${x} ${y + h - 1} Z`, c, "url(#paper)") + path(`M${x + w - 9} ${y + 1} L${x + w - 10} ${y + 11} L${x + w} ${y + 10}`, c) + [20, 28, 36].filter((n) => n < h - 8).map((n) => path(`M${x + 8} ${y + n} l${w - 17} 0`, c, "none", 1.5)).join("");
var clamp = (n) => Math.max(0, Math.min(1, n));
var ease = (n) => 1 - (1 - clamp(n)) ** 3;
var group = (content, x = 0, y = 0, angle = 0, cx = 0, cy = 0) => `<g transform="translate(${x} ${y}) rotate(${angle} ${cx} ${cy})">${content}</g>`;
function artwork(d, elapsed, cueElapsed = elapsed, readingRight = false, edge = null) {
  const cl = COMPANION_SCENE_GEOMETRY.computerLeft, cr = COMPANION_SCENE_GEOMETRY.computerRight;
  const seconds = elapsed / 1e3, reduced = d.reducedMotion, active = d.phase === "active";
  const wave = reduced || !active ? 0 : Math.sin(seconds * 1.5);
  const entrance = reduced ? 1 : ease(elapsed / 300);
  const legacy = d.cue === "engaged";
  const motion = active && !reduced;
  const stroke = reduced ? 1 : ease(cueElapsed / 180);
  let z = "";
  switch (d.kind) {
    case "reading": {
      const cycle = seconds % 4.8 / 4.8, flip = motion && (d.cue === "page-turn" || legacy && cycle > 0.66) ? Math.sin((legacy ? (cycle - 0.66) / 0.34 : clamp(cueElapsed / 240)) * Math.PI) : 0;
      z = group(page(10, 81, 43, 57), -18 * (1 - entrance), 5 * (1 - entrance), -8 * entrance, 50, 135) + group(page(24, 73, 47, 64), 0, 2 * wave, 13 * flip, 67, 125) + path(`M31 ${94 + (motion && (legacy || d.cue === "read") ? (legacy ? cycle / 0.66 % 1 : clamp(cueElapsed / 800)) * 28 : 9)} L61 ${94 + (motion && (legacy || d.cue === "read") ? (legacy ? cycle / 0.66 % 1 : clamp(cueElapsed / 800)) * 28 : 9)}`, cyan, "none", 4);
      z = group(z, readingRight ? 210 : 0) + path(readingRight ? `M234 130 Q212 138 ${cr.x} ${cr.y}` : `M72 125 Q86 130 ${cl.x} ${cl.y}`, cyan);
      break;
    }
    case "editing": {
      const cycle = seconds % 4.2 / 4.2, rewrite = motion && (d.cue === "revise" || legacy && cycle > 0.6) ? Math.sin((legacy ? (cycle - 0.6) / 0.4 : clamp(cueElapsed / 240)) * Math.PI) : 0;
      const fill = motion && (legacy || d.cue === "type" || d.cue === "revise") ? 0.45 + 0.55 * (legacy ? Math.min(1, cycle / 0.6) : stroke) : 0.8;
      z = path("M218 93 Q247 89 287 94 L286 152 Q251 149 220 154 Z", blue, "url(#paper)");
      [48, 34, 43].forEach((len, i) => z += path(`M228 ${108 + i * 13} l${len * fill} 0`, blue, "none", 3));
      z += path("M278 102 l0 13", purple, "none", 3) + group(path("M230 120 l30 0", purple, "none", 7), 0, -14 * rewrite, -4 * rewrite, 230, 120);
      const shift = edge === "right" ? -207 : 0;
      z = group(z, shift + 28 * (1 - entrance), wave) + path(`M${218 + shift} 152 Q${190 + shift / 2} 168 ${cr.x} ${cr.y}`, purple);
      break;
    }
    case "searching": {
      const focusVisible = legacy || ["scan-left", "scan-right", "select"].includes(d.cue);
      const scanX = d.cue === "scan-left" ? 35 : 250, scanY = d.cue === "scan-left" ? 119 : 105;
      const cycle = seconds % 5 / 5, select = motion && (legacy || d.cue === "select") ? legacy ? Math.max(0, Math.sin((cycle - 0.25) * Math.PI * 2)) : stroke : 0;
      z = group(page(9, 105, 34, 33), -18 * (1 - entrance), 4 * wave) + group(page(237, 74, 34, 33, cyan), 18 * (1 - entrance), -2 * wave) + group(page(250, 141, 34, 33), 25 * (1 - entrance) - 8 * select, 2 * wave - 10 * select) + path("M40 99 Q62 77 84 70 M218 72 Q240 86 251 112", cyan) + (focusVisible ? `<circle cx="${scanX + 5 * select}" cy="${scanY + 12 * (1 - select)}" r="22" fill="none" stroke="${gold}" stroke-width="2.5"/>` : "") + (focusVisible ? path(`M${scanX + 17 + 5 * select} ${scanY + 18 + 12 * (1 - select)} l10 10`, gold, "none", 3) : "");
      break;
    }
    case "dispatch": {
      const send = reduced ? 1 : ease((legacy ? elapsed : cueElapsed) / 280);
      const sendLeft = legacy || d.cue === "dispatch-left", sendRight = legacy || d.cue === "dispatch-right";
      const lx = edge === "left" ? 242 : 13, ly = edge === "left" ? 163 : 79, rx = edge === "right" ? 15 : 244, ry = edge === "right" ? 156 : 72;
      const lt = { x: lx + 17, y: ly + 38 }, rt = { x: rx + 17, y: ry + 38 };
      z = path(`M${cl.x} ${cl.y} Q${(cl.x + lt.x) / 2} ${Math.max(cl.y, lt.y) + 8} ${lt.x} ${lt.y} M${cr.x} ${cr.y} Q${(cr.x + rt.x) / 2} ${Math.max(cr.y, rt.y) + 8} ${rt.x} ${rt.y}`, purple) + group(page(lx, ly, 35, 38, purple), -20 * (1 - entrance), wave) + group(page(rx, ry, 35, 38, cyan), 20 * (1 - entrance), -wave) + (sendLeft ? dot(cl.x + (lt.x - cl.x) * send, cl.y + (lt.y - cl.y) * send, purple, 4) : "") + (sendRight ? dot(cr.x + (rt.x - cr.x) * send, cr.y + (rt.y - cr.y) * send, cyan, 4) : "");
      if (d.count !== null) z += `<text x="${rx + 23}" y="${ry + 29}" text-anchor="middle" fill="${ink}" font-size="12" font-family="system-ui">${d.count}</text>`;
      break;
    }
    case "question": {
      const answered = d.phase === "resolve" && d.outcome === "answered";
      z = path("M214 76 Q216 69 227 70 L275 71 Q285 72 284 83 L283 116 Q281 124 269 123 L236 123 L217 137 L222 121 Q212 121 213 110 Z", blue, "url(#paper)");
      z += answered ? path("M227 91 l42 0 M227 102 l29 0", peach, "none", 3) : `<text x="248" y="101" text-anchor="middle" fill="${blue}" font-size="28" font-family="system-ui">?</text>`;
      z += path("M210 145 Q223 139 228 129", peach);
      if (!answered) [0, 1, 2].forEach((i) => z += `<g opacity="${reduced ? 0.65 : 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(seconds * 1.6 - i))}">${dot(232 + i * 12, 112, peach, 2)}</g>`);
      z = group(z, 4 + 15 * (1 - entrance), -3 * wave);
      break;
    }
    case "permission": {
      const decided = d.phase === "resolve", allowed = decided && d.outcome === "allowed", denied = decided && d.outcome === "denied";
      const progress = reduced ? 1 : ease(elapsed / 480);
      z = group(page(214, 127, 32, 35), allowed ? 45 * progress : denied ? -30 * progress : -22 * (1 - entrance), 0) + path(allowed ? `M255 118 L${255 + 20 * progress} 119 M255 171 L${255 + 20 * progress} 170` : "M255 118 L255 171", gold, "none", 3) + path("M261 103 L281 103 L281 120 L261 120 Z", gold, "url(#paper)") + path(allowed ? "M265 103 L265 95 Q271 84 278 95" : "M265 103 L265 95 Q271 84 278 95 L278 103", gold) + dot(271, 110, gold, 2) + path("M237 145 L249 145", blue);
      if (!decided) z += path(`M263 ${129 + wave} l15 0 M266 ${134 + wave} l10 0`, gold);
      break;
    }
  }
  if (d.count && ["reading", "editing", "searching"].includes(d.kind ?? "")) {
    z += path("M57 171 l-10 0 M47 171 l-10 -10 M47 171 l-10 10", purple) + dot(34, 161, purple, 4) + dot(34, 181, cyan, 4) + `<text x="61" y="175" fill="${ink}" font-size="11" font-family="system-ui">${d.count}</text>`;
  }
  return z;
}
function mountCompanionScene(root) {
  root.style.cssText = "position:fixed;inset:0;overflow:hidden;pointer-events:none;user-select:none";
  root.setAttribute("aria-hidden", "true");
  let current = null, previous = null, started = 0, previousAt = 0, lastRevision = -1, frame = 0, phaseStarted = 0, previousElapsed = 0, cueStarted = 0;
  const render = (now) => {
    frame = 0;
    if (!current || current.descriptor.suppressed || current.descriptor.menuOpen || !current.descriptor.kind || document.hidden) {
      root.replaceChildren();
      return;
    }
    const { descriptor: d, layout: l } = current, elapsed = now - started;
    const w = root.clientWidth || 522, h = root.clientHeight || 432;
    const scale = l.character.width * w / COMPANION_SCENE_GEOMETRY.character.width, tx = l.character.x * w - COMPANION_SCENE_GEOMETRY.character.x * scale, ty = l.character.y * h - COMPANION_SCENE_GEOMETRY.character.y * scale;
    const face = COMPANION_SCENE_GEOMETRY.protectedFace;
    const leftEdge = (l.visible.x * w - tx) / scale, rightEdge = ((l.visible.x + l.visible.width) * w - tx) / scale;
    const leftCrop = leftEdge > 9, rightCrop = rightEdge < 285;
    const lane = (content) => `<g clip-path="url(#outside-face)">${content}</g>`;
    const terminal = d.phase !== "active", phaseAge = now - phaseStarted;
    const end = d.phase === "resolve" ? 900 : 600;
    const opacity = terminal ? 1 - clamp((phaseAge - (d.phase === "resolve" ? 500 : 0)) / (d.phase === "resolve" ? 400 : 600)) : d.reducedMotion ? 1 : ease(elapsed / 220);
    let body = lane(artwork(d, elapsed, now - cueStarted, leftCrop && !rightCrop, leftCrop && !rightCrop ? "left" : rightCrop && !leftCrop ? "right" : null));
    if (previous && !d.reducedMotion && now - previousAt < 240 && previous.descriptor.scope === d.scope && !terminal) body = `<g opacity="${1 - (now - previousAt) / 240}">${lane(artwork({ ...previous.descriptor, phase: "withdraw" }, previousElapsed))}</g>` + body;
    const rightOnly = d.kind === "question" || d.kind === "permission";
    let layers = body;
    if (rightCrop && !leftCrop && rightOnly) layers = group(body, -207);
    else if ((leftCrop || rightCrop) && d.kind === "searching") {
      layers = leftCrop ? `<g clip-path="url(#right-lane)">${body}</g><g transform="translate(229 84)"><g clip-path="url(#left-lane)">${body}</g></g>` : `<g clip-path="url(#left-lane)">${body}</g><g transform="translate(-229 84)"><g clip-path="url(#right-lane)">${body}</g></g>`;
    }
    root.innerHTML = `<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paper" x1="0" y1="0" x2=".1" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="#eaf1f8"/></linearGradient><filter id="paper-depth" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="1.5" stdDeviation="1" flood-color="#273449" flood-opacity=".18"/></filter><clipPath id="outside-face"><path d="M-100 -100H400V350H-100Z M${face.x} ${face.y}V${face.y + face.height}H${face.x + face.width}V${face.y}Z" clip-rule="evenodd"/></clipPath><clipPath id="left-lane"><rect x="-100" y="-100" width="250" height="450"/></clipPath><clipPath id="right-lane"><rect x="150" y="-100" width="250" height="450"/></clipPath></defs><g transform="translate(${tx} ${ty}) scale(${scale})" opacity="${d.menuOpen ? 0 : opacity}"><g clip-path="url(#outside-face)" filter="url(#paper-depth)">${layers}</g></g></svg>`;
    if (terminal && phaseAge >= end) {
      root.replaceChildren();
      return;
    }
    if (!d.reducedMotion || terminal) frame = requestAnimationFrame(render);
  };
  const update = (value) => {
    if (value.descriptor.revision < lastRevision) return;
    lastRevision = value.descriptor.revision;
    const same = current?.descriptor.scope === value.descriptor.scope && current?.descriptor.kind === value.descriptor.kind && current?.descriptor.phase === value.descriptor.phase;
    if (!same) {
      const now = performance.now();
      previous = current?.descriptor.scope === value.descriptor.scope && current.descriptor.phase === "active" && current.descriptor.kind !== value.descriptor.kind ? current : null;
      previousElapsed = now - started;
      previousAt = phaseStarted = now;
      if (current?.descriptor.scope !== value.descriptor.scope || current?.descriptor.kind !== value.descriptor.kind || value.descriptor.phase === "active") started = now;
      else if (value.descriptor.phase === "resolve") started = now;
    }
    if (current?.descriptor.cue !== value.descriptor.cue || current?.descriptor.cueInstance !== value.descriptor.cueInstance || !same) cueStarted = performance.now();
    if (current && (current.descriptor.suppressed || current.descriptor.menuOpen) && !value.descriptor.suppressed && !value.descriptor.menuOpen) {
      started = phaseStarted = cueStarted = performance.now();
      previous = null;
    }
    current = value;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  const event = (e) => update(e.detail);
  const visibility = () => {
    if (frame) cancelAnimationFrame(frame);
    if (document.hidden) root.replaceChildren();
    else {
      started = performance.now();
      frame = requestAnimationFrame(render);
    }
  };
  window.addEventListener("varin-companion-scene", event);
  document.addEventListener("visibilitychange", visibility);
  document.documentElement.dataset.varinCompanionSceneReady = "true";
  window.dispatchEvent(new Event("varin-companion-scene-ready"));
  return { update, dispose: () => {
    delete document.documentElement.dataset.varinCompanionSceneReady;
    cancelAnimationFrame(frame);
    root.replaceChildren();
    window.removeEventListener("varin-companion-scene", event);
    document.removeEventListener("visibilitychange", visibility);
  } };
}
export {
  mountCompanionScene
};
