import { ArtRenderer } from "./art-renderer.mjs";
import { sampleStudy, VisualClock } from "./motion.mjs";
const $ = (s) => document.querySelector(s),
  root = "assets/art-study-v1/",
  renderer = new ArtRenderer($("#art")),
  clock = new VisualClock();
let t = 0,
  playing = false,
  raf = null;
const abort = new AbortController(),
  on = (el, event, fn) =>
    el.addEventListener(event, fn, { signal: abort.signal });
async function read(path) {
  const r = await fetch(root + path);
  if (!r.ok) throw Error(path);
  return r.json();
}
async function img(path) {
  const i = new Image();
  i.src = root + path;
  await i.decode();
  return i;
}
try {
  const [partition, underlap, anchors] = await Promise.all([
    read("partition-manifest.json"),
    read("underlap-manifest.json"),
    read("anchors-source.json"),
  ]);
  const maps = await Promise.all(
    [partition, underlap].map(
      async (m) =>
        new Map(
          await Promise.all(
            m.assets.map(async (a) => [a.node, await img(a.path)]),
          ),
        ),
    ),
  );
  const props = {};
  for (const n of ["chair", "laptopBase", "laptopLid"])
    props[n] = await img("props/" + n + ".png");
  for (const a of partition.assets) {
    const option = document.createElement("option");
    option.value = option.textContent = a.node;
    $("#layer").append(option);
  }
  const configure = () => {
    const motion = $("#motion").checked;
    renderer.setAssets(motion ? underlap : partition, maps[motion ? 1 : 0]);
    renderer.setProps(motion ? props : null);
    $("#status").textContent = motion
      ? "受限头/胸微动与局部指尖起落；当前不启用未验收眨眼/拖动"
      : "原始10分区静态重建；RGBA差=0";
  };
  function draw() {
    renderer.draw({
      only: $("#layer").value,
      anchors: $("#anchors").checked ? anchors.anchorsApproximatePixels : null,
      pose: $("#motion").checked ? sampleStudy(t).pose() : null,
      motionMode: "limited-cutout",
    });
    $("#artSeek").value = t;
    $("#artTime").textContent = t.toFixed(3) + " s";
  }
  on($("#motion"), "change", () => {
    configure();
    draw();
  });
  on($("#layer"), "change", draw);
  on($("#anchors"), "change", draw);
  on($("#artPlay"), "click", () => {
    if (t >= 8) t = 0;
    playing = !playing;
    $("#artPlay").textContent = playing ? "暂停" : "播放8秒";
  });
  on($("#artStep"), "click", () => {
    playing = false;
    t = Math.min(8, t + 1 / 60);
    draw();
  });
  on($("#artSeek"), "input", (e) => {
    playing = false;
    t = Number(e.target.value);
    draw();
  });
  function frame(now) {
    raf = null;
    const dt = clock.tick(now);
    if (playing) {
      t = Math.min(8, t + dt);
      if (t === 8) {
        playing = false;
        $("#artPlay").textContent = "播放8秒";
      }
      draw();
    }
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }
  on(document, "visibilitychange", () => {
    clock.setHidden(document.hidden);
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = null;
    } else if (raf === null) raf = requestAnimationFrame(frame);
  });
  on(window, "pagehide", () => {
    abort.abort();
    cancelAnimationFrame(raf);
  });
  configure();
  draw();
  raf = requestAnimationFrame(frame);
  for (const item of partition.missing) {
    const li = document.createElement("li");
    li.textContent = item;
    $("#missing").append(li);
  }
} catch (error) {
  $("#status").textContent = "未载入：" + error.message;
}
