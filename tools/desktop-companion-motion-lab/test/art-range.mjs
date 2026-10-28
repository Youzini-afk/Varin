import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { ArtRenderer } from "../src/art-renderer.mjs";
import { sampleStudy } from "../src/motion.mjs";
const root = "assets/art-study-v1/",
  manifest = JSON.parse(
    await readFile(root + (process.env.ART_MANIFEST??"underlap-manifest.json"), "utf8"),
  ),
  loaded = new Map();
for (const a of manifest.assets)
  loaded.set(a.node, await loadImage(root + a.path));
const canvas = createCanvas(1382, 1382),
  r = new ArtRenderer(canvas, createCanvas);
r.setAssets(manifest, loaded);
const props = {};
for (const n of ["chair", "laptopBase", "laptopLid"])
  props[n] = await loadImage(root + "props/" + n + ".png");
r.setProps(props);
for (const [name, tuning] of Object.entries({
  small: { headAngleScale: 0.06, headLift: 0, breathScale: 0.45 },
  natural: { headAngleScale: 0.35, headLift: 5, breathScale: 0.8 },
  limit: { headAngleScale: 0.55, headLift: 8, breathScale: 1 },
})) {
  for (const t of [2.3, 3.7]) {
    const p = sampleStudy(t).pose();
    r.draw({
      background: "#243146",
      pose: p,
      motionMode: "limited-cutout",
      tuning,
    });
    const out = createCanvas(800, 800);
    out.getContext("2d").drawImage(canvas, 0, 0, 800, 800);
    await writeFile(
      `evidence/art-study/range-${process.env.ART_TAG??""}${name}-${t}.png`,
      out.toBuffer("image/png"),
    );
    const crop = createCanvas(720, 520);
    crop.getContext("2d").drawImage(canvas, 400, 380, 540, 390, 0, 0, 720, 520);
    await writeFile(
      `evidence/art-study/seam-${process.env.ART_TAG??""}${name}-${t}.png`,
      crop.toBuffer("image/png"),
    );
  }
}
console.log(
  "3 amplitude ranges rendered at notice and reading; pending visual review",
);
