#!/usr/bin/env python3
"""Render a labeled review video without adding in-betweens or fixed-FPS motion."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--stage', choices=['keyposes', 'motion-candidate'], required=True)
    args = parser.parse_args()
    data = json.loads(args.package.read_text())
    if data.get('stage') == 'keyposes' and args.stage != 'keyposes':
        parser.error('Keypose source cannot be relabeled as motion candidate')
    label = 'KEY POSE REVIEW - NOT FINAL ANIMATION' if args.stage == 'keyposes' else 'MOTION CANDIDATE - VISUAL REVIEW REQUIRED'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='varin-review-') as directory:
        root = Path(directory)
        pages = [Image.open(args.package.parent / p['file']).convert('RGBA') for p in data['pages']]
        width, height = data['canvas']
        width += width % 2
        height += height % 2
        lines = ['ffconcat version 1.0']
        for index, frame in enumerate(data['frames']):
            drawing = Image.new('RGBA', (width, height + 40), '#d7e5e8')
            x, y, w, h = frame['rect']
            drawing.alpha_composite(pages[frame['page']].crop((x, y, x+w, y+h)), tuple(frame['offset']))
            draw = ImageDraw.Draw(drawing)
            draw.rectangle((0,height,width,height+40),fill='#20242b')
            draw.text((8,height+5),label,fill='white')
            draw.text((8,height+22),f'{index+1}/{len(data["frames"])} | {frame["durationMs"]} ms',fill='white')
            name = f'{index:05d}.png'
            drawing.convert('RGB').save(root/name)
            # Millisecond time base is timestamp precision, not generated motion frames.
            duration = frame['durationMs'] / 1000
            if index == len(data['frames']) - 1:
                if duration < 0.001:
                    raise ValueError('Review video requires last drawing to last at least 1 ms')
                duration -= 0.001
            lines += [f"file '{name}'", 'option framerate 1000', f'duration {duration:.6f}']
        lines += [f"file '{name}'", 'option framerate 1000']
        (root/'input.ffconcat').write_text('\n'.join(lines)+'\n')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-safe','0','-f','concat','-i',str(root/'input.ffconcat'),'-fps_mode','vfr','-enc_time_base','1:1000','-c:v','libx264','-bf','0','-pix_fmt','yuv420p','-video_track_timescale','1000','-t',str(data['durationMs']/1000),str(args.output.resolve())],check=True)
    print(f'Wrote labeled {args.stage} review: {args.output}')


if __name__ == '__main__':
    main()
