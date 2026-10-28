import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { ArtRenderer } from "../src/art-renderer.mjs";
const root = "assets/art-study-v1/",
  manifest = JSON.parse(
    await readFile(root + "partition-manifest.json", "utf8"),
  ),
  loaded = new Map();
for (const a of manifest.assets)
  loaded.set(a.node, await loadImage(root + a.path));
const c = createCanvas(...manifest.canvas),
  r = new ArtRenderer(c, createCanvas);
r.setAssets(manifest, loaded);
r.draw();
const ref = createCanvas(...manifest.canvas);
ref.getContext("2d").drawImage(await loadImage(root + manifest.source), 0, 0);
const a = c.getContext("2d").getImageData(0, 0, ...manifest.canvas).data,
  b = ref.getContext("2d").getImageData(0, 0, ...manifest.canvas).data;
let max = 0,
  different = 0;
for (let i = 0; i < a.length; i++) {
  const d = Math.abs(a[i] - b[i]);
  max = Math.max(max, d);
  if (d) different++;
}
await mkdir("evidence/art-study", { recursive: true });
await writeFile(
  "evidence/art-study/static-reconstruction.png",
  c.toBuffer("image/png"),
);
const report = {
  sourceSize: manifest.canvas,
  layers: manifest.assets.length,
  canvasDecodedMaxChannelDifference: max,
  canvasDecodedDifferentChannels: different,
  status: "static-only; occlusion overlap not yet supplied",
};
await writeFile(
  "evidence/art-study/static-report.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
assert.equal(max, 0);
r.draw({
  background: "#243146",
  anchors: JSON.parse(await readFile(root + "anchors-source.json", "utf8"))
    .anchorsApproximatePixels,
});
await writeFile(
  "evidence/art-study/anchor-calibration.png",
  c.toBuffer("image/png"),
);
