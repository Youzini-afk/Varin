import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ArtRenderer } from "../src/art-renderer.mjs";
import { sampleStudy } from "../src/motion.mjs";
import { handVertex } from "../src/art-deform.mjs";
const root = "assets/art-study-v1/",
  manifest = JSON.parse(
    await readFile(root + "underlap-manifest.json", "utf8"),
  ),
  loaded = new Map();
for (const a of manifest.assets)
  loaded.set(a.node, await loadImage(root + a.path));
const canvas = createCanvas(1382, 1382),
  r = new ArtRenderer(canvas, createCanvas);
r.setAssets(manifest, loaded);
const ref = createCanvas(1382, 1382),
  rc = ref.getContext("2d");
rc.drawImage(await loadImage(root + manifest.source), 0, 0);
const reference = rc.getImageData(0, 0, 1382, 1382).data;
const mask = [];
for (let y = 4; y < 1378; y++)
  for (let x = 4; x < 1378; x++) {
    let valid = true;
    for (const [dx, dy] of [
      [0, 0],
      [-4, 0],
      [4, 0],
      [0, -4],
      [0, 4],
    ])
      if (reference[((y + dy) * 1382 + x + dx) * 4 + 3] < 250) valid = false;
    if (valid) mask.push((y * 1382 + x) * 4 + 3);
  }
const reports = [];
for (const t of [0, 1.65, 2.5, 3.7, 5.5, 7.5]) {
  const p = sampleStudy(t).pose();
  r.draw({ pose: p, motionMode: "limited-cutout" });
  const pixels = canvas.getContext("2d").getImageData(0, 0, 1382, 1382).data;
  let severe = 0,
    min = 255;
  for (const i of mask) {
    if (pixels[i] < 200) severe++;
    min = Math.min(min, pixels[i]);
  }
  reports.push({ t, interiorAlphaBelow200: severe, minInteriorAlpha: min });
  for (const side of ["L", "R"]) {
    const x = side === "L" ? 569 : 737,
      y = side === "L" ? 747 : 751;
    assert.deepEqual(handVertex(side, x, y, p), { x, y });
  }
}
const report = {
  scope:
    "same-source small-motion underlap only; excludes 4px original silhouette boundary",
  interiorSamplePixels: mask.length,
  frames: reports,
  handPalmAnchor: "exactly pinned",
  limits:
    "not full occlusion/art acceptance; closed eye and independent fingers pending",
};
await writeFile(
  "evidence/art-study/integrity-report.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
assert.ok(
  reports.every((x) => x.interiorAlphaBelow200 === 0),
  "Visible interior seam found",
);
