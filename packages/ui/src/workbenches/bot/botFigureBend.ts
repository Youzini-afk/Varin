import type { FigureAttachment, FigurePoint } from './botFigureArtwork';

type Clip = (id: string, path: string) => string;
type Triangle = readonly [number, number, number];

/**
 * Deform the piece in its root-to-tip frame. Adjacent triangles share vertices, and their clips
 * overlap slightly to avoid seams from SVG antialiasing. The part behind the root stays fixed.
 */
export function buildBendingAttachment(
  def: FigureAttachment & { tip: FigurePoint },
  host: SVGGElement,
  artworkId: string,
  clip: Clip,
): (angle: number, velocity: number) => void {
  const [px, py] = def.pivot, [tx, ty] = def.tip;
  const length = Math.hypot(tx - px, ty - py);
  const axis = Math.atan2(tx - px, py - ty), rotation = axis * 180 / Math.PI;
  const cos = Math.cos(axis), sin = Math.sin(axis);
  const [left, top, right, bottom] = def.bbox ?? [px - length, py - length, px + length, py + length];
  const corners = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([x, y]) => {
    const dx = x - px, dy = y - py;
    return [cos * dx + sin * dy, -sin * dx + cos * dy];
  });
  const padding = 8;
  const minX = Math.min(...corners.map(point => point[0])) - padding;
  const maxX = Math.max(...corners.map(point => point[0])) + padding;
  const span = Math.max(4, -Math.min(...corners.map(point => point[1])) + padding);
  const group = (parent: SVGGElement, transform?: string) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    if (transform) node.setAttribute('transform', transform);
    parent.append(node);
    return node;
  };
  const frame = group(host, `translate(${px} ${py}) rotate(${rotation})`);
  const place = (parent: SVGGElement, cut: string) => {
    const mask = group(parent);
    mask.setAttribute('clip-path', cut);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${artworkId}`);
    use.setAttribute('transform', `rotate(${-rotation}) translate(${-px} ${-py})`);
    mask.append(use);
  };
  place(frame, clip(`root-${def.id}`, 'M-1400 -10H1400V1400H-1400Z'));

  const columns = 4, rows = 7;
  const index = (row: number, column: number) => row * (columns + 1) + column;
  const vertices: FigurePoint[] = Array.from({ length: (columns + 1) * (rows + 1) }, (_, i) => [
    minX + (maxX - minX) * (i % (columns + 1)) / columns,
    -span * Math.floor(i / (columns + 1)) / rows,
  ]);
  const points = vertices.map(([x, y]): [number, number] => [x, y]);
  const triangles: { node: SVGGElement; indices: Triangle; inverse: readonly [number, number, number, number] }[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const a = index(row, col), b = index(row, col + 1), c = index(row + 1, col), d = index(row + 1, col + 1);
      const cell: readonly Triangle[] = (row + col) % 2 ? [[a, b, d], [a, d, c]] : [[a, b, c], [b, d, c]];
      for (const indices of cell) {
        const [p, q, r] = indices.map(i => vertices[i]);
        const a11 = q[0] - p[0], a12 = r[0] - p[0], a21 = q[1] - p[1], a22 = r[1] - p[1];
        const det = a11 * a22 - a12 * a21;
        const cx = (p[0] + q[0] + r[0]) / 3, cy = (p[1] + q[1] + r[1]) / 3;
        const outline = [p, q, r].map(([x, y]) => {
          const scale = padding / (Math.hypot(x - cx, y - cy) || 1);
          return `${(x + (x - cx) * scale).toFixed(2)} ${(y + (y - cy) * scale).toFixed(2)}`;
        });
        const node = group(frame);
        place(node, clip(`triangle-${def.id}-${triangles.length}`, `M${outline.join('L')}Z`));
        triangles.push({ node, indices, inverse: [a22 / det, -a12 / det, -a21 / det, a11 / det] });
      }
    }
  }

  let lastAngle = '0.000', lastStretch = '1.0000';
  return (angle, velocity) => {
    const stretch = 1 + Math.min(.045, Math.abs(velocity) * .0002);
    const angleKey = angle.toFixed(3), stretchKey = stretch.toFixed(4);
    if (angleKey === lastAngle && stretchKey === lastStretch) return;
    lastAngle = angleKey;
    lastStretch = stretchKey;
    const radians = angle * Math.PI / 180;
    // The first 16% stays anchored. The bend eases to the full angle at 72% of the length.
    vertices.forEach(([x, y], i) => {
      const t = Math.min(1, Math.max(0, (-y - length * .16) / (length * .56)));
      const rotation = radians * t * t * (3 - 2 * t);
      const stretchedY = y * (1 + (stretch - 1) * t);
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      points[i][0] = x * cos - stretchedY * sin;
      points[i][1] = x * sin + stretchedY * cos;
    });
    for (const { node, indices: [i, j, k], inverse: [i11, i12, i21, i22] } of triangles) {
      const [x, y] = points[i], [ox, oy] = vertices[i];
      const m11 = points[j][0] - x, m12 = points[k][0] - x;
      const m21 = points[j][1] - y, m22 = points[k][1] - y;
      const a = m11 * i11 + m12 * i21, b = m21 * i11 + m22 * i21;
      const c = m11 * i12 + m12 * i22, d = m21 * i12 + m22 * i22;
      const e = x - a * ox - c * oy, f = y - b * ox - d * oy;
      node.setAttribute('transform', `matrix(${a.toFixed(5)} ${b.toFixed(5)} ${c.toFixed(5)} ${d.toFixed(5)} ${e.toFixed(2)} ${f.toFixed(2)})`);
    }
  };
}
