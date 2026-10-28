import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { ArtRenderer } from "../src/art-renderer.mjs";
import { sampleStudy } from "../src/motion.mjs";
const root = "assets/art-study-v3/",
  manifest = JSON.parse(
    await readFile(root + "runtime-manifest.json", "utf8"),
  ),
  loaded = new Map();
for (const a of manifest.assets)
  loaded.set(a.node, await loadImage(root + a.path));
const canvas = createCanvas(1382, 1382),
  r = new ArtRenderer(canvas, createCanvas);
r.setAssets(manifest, loaded);
const face = {makeCanvas:createCanvas,meta:JSON.parse(await readFile(root+'face-layers/manifest.json','utf8')),morphMeta:JSON.parse(await readFile(root+'face-layers/blink-v3-manifest.json','utf8'))};
for(const side of ['L','R'])for(const state of ['open','half','closed'])face[state+side]=await loadImage(root+'face-layers/'+(state==='open'?'eye'+side+'.png':state+'Eye'+side+'-v3.png'));
r.setFace(face);
for (const b of [0, 0.25, 0.5, 0.75, 1]) {
  const p = sampleStudy(0).pose();
  p.blink = b;
  r.draw({ background: "#243146", pose: p, motionMode: "limited-cutout" });
  const closeup = createCanvas(600, 450);
  closeup
    .getContext("2d")
    .drawImage(canvas, 500, 315, 330, 248, 0, 0, 600, 450);
  await writeFile(
    `evidence/art-study/blink-morph-${b}.png`,
    closeup.toBuffer("image/png"),
  );
}
console.log("blink local trial frames rendered; not approved");
