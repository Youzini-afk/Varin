import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ArtRenderer } from "../src/art-renderer.mjs";
import { sampleStudy } from "../src/motion.mjs";
const root = "assets/art-study-v1/",
  manifest = JSON.parse(
    await readFile(root + "underlap-manifest.json", "utf8"),
  ),
  loaded = new Map();
for (const a of manifest.assets)
  loaded.set(a.node, await loadImage(root + a.path));
const canvas = createCanvas(800, 800),
  r = new ArtRenderer(canvas, createCanvas);
r.setAssets(manifest, loaded);
const props = {};
for (const node of ["chair", "laptopBase", "laptopLid"])
  props[node] = await loadImage(root + "props/" + node + ".png");
r.setProps(props);
await mkdir("evidence/art-study/cutout-frames", { recursive: true });
for (const t of [0, 1.65, 2.5, 3.7, 7.5]) {
  r.draw({
    background: "#243146",
    pose: sampleStudy(t).pose(),
    motionMode: "limited-cutout",
  });
  await writeFile(
    `evidence/art-study/cutout-study-${t}.png`,
    canvas.toBuffer("image/png"),
  );
}
console.log("limited cutout key poses rendered");
