#!/usr/bin/env python3
"""Pack authored RGBA drawings without generating, tweening or retiming motion."""
import argparse
import hashlib
import json
import math
import io
import re

import PIL
from pathlib import Path

from PIL import Image


def positive_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f'{label} must be a finite positive number')
    return value


def pair(value, label):
    if not isinstance(value, list) or len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, int) for v in value):
        raise ValueError(f'{label} must contain two integers')
    return value


def pack(manifest_path, output, max_size=2048, padding=2):
    manifest_path = manifest_path.resolve()
    spec = json.loads(manifest_path.read_text())
    width, height = pair(spec['canvas'], 'canvas')
    if min(width, height) <= 0 or max_size <= padding * 2 or padding < 0:
        raise ValueError('canvas, atlas size and padding must be valid positive dimensions')
    frames = spec.get('frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('frames must be a non-empty authored sequence')
    if not isinstance(spec.get('id'), str) or not spec['id']:
        raise ValueError('id must identify the authored action')
    images = []
    output_frames = []
    total = 0
    root = manifest_path.parent
    for index, frame in enumerate(frames):
        duration = positive_number(frame['durationMs'], f'frames[{index}].durationMs')
        source = (root / frame['source']).resolve()
        if not source.is_relative_to(root):
            raise ValueError(f'frames[{index}] source escapes the action directory')
        offset = pair(frame.get('offset', [0, 0]), f'frames[{index}].offset')
        with Image.open(source) as opened:
            image = opened.convert('RGBA')
        if min(offset) < 0 or offset[0] + image.width > width or offset[1] + image.height > height:
            raise ValueError(f'frames[{index}] source exceeds the registered canvas; register explicitly, do not silently scale')
        bounds = image.getchannel('A').getbbox()
        if bounds is None:
            raise ValueError(f'frames[{index}] is entirely transparent')
        trimmed = image.crop(bounds)
        if trimmed.width + 2 * padding > max_size or trimmed.height + 2 * padding > max_size:
            raise ValueError(f'frames[{index}] cannot fit atlas; choose a larger --max-size, not smaller art')
        contacts = frame.get('contacts', {})
        if not isinstance(contacts, dict):
            raise ValueError(f'frames[{index}].contacts must be an object')
        for name, point in contacts.items():
            x, y = pair(point, f'frames[{index}].contacts.{name}')
            if not 0 <= x <= width or not 0 <= y <= height:
                raise ValueError(f'frames[{index}] contact {name} exceeds canvas')
        images.append(trimmed)
        record = {
            'source': frame['source'], 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'startMs': total, 'durationMs': duration,
            'offset': [offset[0] + bounds[0], offset[1] + bounds[1]],
            'contacts': contacts,
        }
        for field in ('phase', 'pose', 'exitTo', 'motion', 'cue'):
            if field in frame:
                record[field] = frame[field]
        output_frames.append(record)
        total += duration
    loop = spec.get('loop')
    if loop is False:
        loop = None
    if loop is not None:
        start, end = pair(loop, 'loop')
        if not 0 <= start < end <= len(frames):
            raise ValueError('loop is a [start, endExclusive] frame range')
    # Shelf packing keeps author order. No source rescaling or in-between generation.
    output.mkdir(parents=True, exist_ok=True)
    page_names = []

    def write_page(canvas, used_width, used_height):
        name = f'atlas-{len(page_names):03d}.png'
        with canvas.crop((0, 0, used_width, used_height)) as cropped:
            cropped.save(output / name)
            page_names.append({'file': name, 'size': list(cropped.size)})
        canvas.close()

    placements = {}
    page = Image.new('RGBA', (max_size, max_size))
    x = y = row_height = used_width = used_height = 0
    for image, record in zip(images, output_frames):
        image_key = (image.size, hashlib.sha256(image.tobytes()).hexdigest())
        if image_key in placements:
            record.update(placements[image_key])
            image.close()
            continue
        cell_width, cell_height = image.width + 2 * padding, image.height + 2 * padding
        if x + cell_width > max_size:
            x, y, row_height = 0, y + row_height, 0
        if y + cell_height > max_size:
            write_page(page, used_width, used_height)
            page = Image.new('RGBA', (max_size, max_size))
            x = y = row_height = used_width = used_height = 0
        px, py = x + padding, y + padding
        page.paste(image, (px, py))
        # Extrude edge texels into gutters to prevent linear-sampling atlas seams.
        if padding:
            page.paste(image.crop((0, 0, 1, image.height)).resize((padding, image.height)), (x, py))
            page.paste(image.crop((image.width - 1, 0, image.width, image.height)).resize((padding, image.height)), (px + image.width, py))
            strip = page.crop((x, py, x + cell_width, py + 1)).resize((cell_width, padding))
            page.paste(strip, (x, y))
            strip = page.crop((x, py + image.height - 1, x + cell_width, py + image.height)).resize((cell_width, padding))
            page.paste(strip, (x, py + image.height))
        placement = dict(page=len(page_names), rect=[px, py, image.width, image.height])
        placements[image_key] = placement
        record.update(placement)
        x += cell_width
        row_height = max(row_height, cell_height)
        used_width, used_height = max(used_width, x), max(used_height, y + cell_height)
        image.close()
    write_page(page, used_width, used_height)
    package = {
        'version': 1, 'id': spec['id'], 'family': spec.get('family'),
        'stage': spec.get('stage'), 'warning': spec.get('warning'),
        'reviewStatus': spec.get('reviewStatus'), 'kind': spec.get('kind', 'action'),
        'geometryReference': spec.get('geometryReference'), 'action': spec.get('action'),
        'canvas': [width, height], 'durationMs': total, 'loop': loop,
        'uniqueImages': len(placements),
        'entryPose': spec.get('entryPose'), 'exitPose': spec.get('exitPose'),
        'pages': page_names, 'frames': output_frames,
    }
    (output / 'sequence.json').write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
    return package


# The approved original plate remains authority; this mode does not change bundle selectors.
FROZEN_STOOL_SHA256 = 'b16b339dd67bbbdc90c45a4171fbe10fe8ab5e1b4ec67914fa6e65a28cfadfa7'


def prepare_seated(manifest_path, output):
    """Explicit source preparation only: fixed plate below authored seated foreground.

    Complete pickup bodies are separate optional inputs, never inferred from the
    seated foreground. All identities below refer to actual encoded PNG bytes.
    """
    manifest_path, output = manifest_path.resolve(), output.resolve()
    manifest_bytes = manifest_path.read_bytes()
    spec = json.loads(manifest_bytes)
    if spec.get('version') != 1:
        raise ValueError('Expected seated preparation manifest version 1')
    frames = spec.get('frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('Expected non-empty seated foreground frames')
    inputs = {manifest_path}

    def read_input(row):
        path = (manifest_path.parent / row['source']).resolve()
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if row.get('sha256') != digest:
            raise ValueError(f'Source SHA mismatch: {path}')
        with Image.open(io.BytesIO(data)) as opened:
            if opened.format != 'PNG' or opened.mode != 'RGBA':
                raise ValueError(f'Expected authored RGBA PNG: {path}')
            if opened.size not in ((512, 512), (1254, 1254)):
                raise ValueError(f'Expected full 512 or 1254 square canvas: {path}')
            size = list(opened.size)
            image = opened.copy()
        inputs.add(path)
        provenance = {'source': row['source'], 'sha256': digest, 'canvas': size}
        return image, provenance

    plate, plate_input = read_input(spec['worldStool'])
    if plate_input['sha256'] != FROZEN_STOOL_SHA256 or plate.size != (512, 512):
        raise ValueError('World stool is not the frozen original 512px plate')
    prepared, ids = [], set()
    for row in frames:
        name = row['id']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', name) or name in ids:
            raise ValueError('Frame id must be unique and filename-safe')
        ids.add(name)
        foreground, foreground_input = read_input(row)
        if foreground.size != (512, 512):
            foreground = foreground.resize((512, 512), Image.Resampling.LANCZOS)
        drawing = Image.alpha_composite(plate, foreground)
        detached = None
        if 'detached' in row:
            body, body_input = read_input(row['detached'])
            if body.size != (512, 512):
                body = body.resize((512, 512), Image.Resampling.LANCZOS)
            detached = (body, body_input)
        prepared.append((name, drawing, foreground_input, detached))

    # Validate every input before producing files, and never overwrite any source.
    targets = {output / 'prepared.json', output / 'detached-index.json'}
    for name, _, _, detached in prepared:
        targets.add(output / f'{name}-ordinary.png')
        if detached:
            targets.add(output / f'{name}-detached.png')
    if any(path.resolve() in inputs for path in targets):
        raise ValueError('Preparation output would overwrite an input')
    output.mkdir(parents=True, exist_ok=True)
    records, entries = [], []

    def write_png(name, image):
        buffer = io.BytesIO()
        image.save(buffer, format='PNG', optimize=False, compress_level=9)
        data = buffer.getvalue()
        (output / name).write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    for name, drawing, foreground_input, detached in prepared:
        filename = f'{name}-ordinary.png'
        digest = write_png(filename, drawing)
        record = {'id': name, 'source': filename, 'sourceSHA256': digest,
                  'foreground': foreground_input, 'pickupStatus': 'missing-authored-counterpart'}
        if detached:
            body, body_input = detached
            body_file = f'{name}-detached.png'
            body_hash = write_png(body_file, body)
            entries.append({'source': filename, 'sourceSHA256': digest,
                            'detachedSource': body_file, 'detachedSHA256': body_hash})
            record.update(pickupStatus='provided-not-visually-accepted', detachedInput=body_input)
        records.append(record)
    result = {'version': 1, 'stage': 'source-study-not-accepted', 'canvas': [512, 512],
              'manifestSHA256': hashlib.sha256(manifest_bytes).hexdigest(),
              'worldStool': plate_input, 'operation': 'whole-canvas-lanczos-512; plate-then-foreground; zero-offset',
              'pillowVersion': PIL.__version__, 'frames': records}
    (output / 'prepared.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    (output / 'detached-index.json').write_text(json.dumps({'version': 1, 'stage': result['stage'], 'entries': entries}, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--max-size', type=int, default=2048, help='Atlas page dimension; increase for larger source art')
    parser.add_argument('--padding', type=int, default=2)
    parser.add_argument('--prepare-seated', action='store_true', help='Prepare explicit fixed-stool + seated-foreground sources only; do not pack or accept art')
    args = parser.parse_args()
    try:
        if args.prepare_seated:
            result = prepare_seated(args.manifest, args.output)
        else:
            result = pack(args.manifest, args.output, args.max_size, args.padding)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f'Cannot package sequence: {error}\n')
    if args.prepare_seated:
        print(f"Prepared {len(result['frames'])} seated source studies; no runtime acceptance")
        return
    print(f"{result['id']}: {len(result['frames'])} exposures / {result['uniqueImages']} unique images, {result['durationMs']} ms, {len(result['pages'])} atlas pages")


if __name__ == '__main__':
    main()
