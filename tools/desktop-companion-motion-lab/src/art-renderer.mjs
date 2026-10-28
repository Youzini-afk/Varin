import { drawBlink } from "./art-face.mjs";
import { drawDeformed, handVertex, attachedHairVertex } from "./art-deform.mjs";
// Stage 2: real same-origin partitions. No default debug anchors or inferred complete rig.
export class ArtRenderer {
  constructor(canvas, makeCanvas = null) {
    this.makeCanvas =
      makeCanvas ??
      ((w, h) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
      });
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.assets = [];
    this.sourceSize = null;
  }
  setAssets(manifest, loaded) {
    const [w, h] = manifest.canvas;
    if (w !== 1382 || h !== 1382) throw Error("Uncalibrated source revision");
    for (const a of manifest.assets) {
      const image = loaded.get(a.node);
      if (!image || image.width !== w || image.height !== h)
        throw Error("Missing or mis-sized layer " + a.node);
    }
    this.assets = manifest.assets.map((a) => ({
      ...a,
      image: loaded.get(a.node),
    }));
    this.rigMeta = manifest;
    this.sourceSize = [w, h];
    this.surface = this.makeCanvas(w, h);
    const c = this.surface.getContext("2d");
    for (const a of this.assets) c.drawImage(a.image, 0, 0);
  }
  setProps(props) {
    this.props = props;
  }
  setFace(face) {
    this.face = face;
    this.faceSurface = this.makeCanvas(...this.sourceSize);
  }
  draw({
    only = null,
    background = null,
    anchors = null,
    pose = null,
    motionMode = "shared-mesh",
    tuning = { headAngleScale: 0.06, headLift: 0, breathScale: 0.45 },
  } = {}) {
    const c = this.ctx,
      [w, h] = this.sourceSize;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.save();
    c.scale(this.canvas.width / w, this.canvas.height / h);
    if (background) {
      c.fillStyle = background;
      c.fillRect(0, 0, w, h);
    }
    let baseDrawn = false;
    if (pose && !only && motionMode === "shared-mesh")
      drawDeformed(c, this.surface, pose);
    else
      for (const a of this.assets)
        if (!only || a.node === only) {
          if (this.props && !only && !baseDrawn && a.node === "handL") {
            c.drawImage(this.props.laptopBase, 0, 0);
            baseDrawn = true;
          }
          c.save();
          if (pose && motionMode === "limited-cutout") {
            const neck = [738, 510];
            if (a.node === "head") {
              c.translate(0, -Math.max(-pose.gaze, 0) * tuning.headLift);
              c.translate(...neck);
              c.rotate((pose.head + 0.035) * tuning.headAngleScale);
              c.translate(-neck[0], -neck[1]);
            }
            if (a.node === "torso")
              c.translate(0, pose.breath * tuning.breathScale);
            if (a.node === "upperArmL" || a.node === "upperArmR") {
              const pivot = a.node === "upperArmL" ? [627, 555] : [794, 565];
              c.translate(...pivot);
              c.rotate(pose.breath * 0.001 * (a.node === "upperArmL" ? 1 : -1));
              c.translate(-pivot[0], -pivot[1]);
            }
            if (a.node === "forearmL" || a.node === "forearmR") {
              const pivot = a.node === "forearmL" ? [569, 747] : [737, 751];
              c.translate(...pivot);
              c.rotate(pose.breath * 0.0008 * (a.node === "forearmL" ? 1 : -1));
              c.translate(-pivot[0], -pivot[1]);
            }
          }
          if (pose && motionMode === "limited-cutout" && this.rigMeta.headAttachmentBand && (a.node === "hairBack" || a.node === "hairFront")) {
            drawDeformed(c,a.image,pose,48,a.bounds??null,(x,y,p)=>attachedHairVertex(x,y,p,tuning,this.rigMeta.headAttachmentBand));
          } else if (a.node === "head" && this.face && pose?.blink > 0) {
            const fc = this.faceSurface.getContext("2d");
            fc.clearRect(0, 0, ...this.sourceSize);
            fc.drawImage(a.image, 0, 0);
            drawBlink(fc, this.face, pose.blink);
            c.drawImage(this.faceSurface, 0, 0);
          } else if (
            pose?.type > 0 &&
            motionMode === "limited-cutout" &&
            (a.node === "handL" || a.node === "handR")
          ) {
            const side = a.node.slice(-1),
              region =
                side === "L" ? [486, 715, 584, 769] : [637, 721, 753, 773];
            drawDeformed(c, a.image, pose, 16, region, (x, y, p) =>
              handVertex(side, x, y, p),
            );
          } else c.drawImage(a.image, 0, 0);
          c.restore();
          if (a.node === "hairBack" && this.props && !only)
            c.drawImage(this.props.chair, 0, 0);
        }
    if (this.props && !only) c.drawImage(this.props.laptopLid, 0, 0);
    if (anchors) {
      c.font = "17px sans-serif";
      for (const [name, [x, y]] of Object.entries(anchors)) {
        c.beginPath();
        c.arc(x, y, 4, 0, Math.PI * 2);
        c.fillStyle = "#f5ae62";
        c.fill();
        c.fillText(name, x + 7, y - 7);
      }
    }
    c.restore();
  }
}
