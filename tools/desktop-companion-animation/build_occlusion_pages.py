#!/usr/bin/env python3
"""Derive alpha-only occlusion pages for an installed companion bundle.

The decorative scene window only needs each drawn exposure's silhouette to keep spatial
props behind the character. It previously fetched and decoded the full colour atlas for
that. This writes, next to the bundle, one page per colour atlas page with RGB=0 and the
exact original alpha, plus occlusion.json bound to the bundle's SHA-256. The colour atlases
and bundle.json are not modified, so existing bundle identities and receipts are unchanged.

Usage: build_occlusion_pages.py <bundle-directory> [--check]
"""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def occlusion_name(page: str) -> str:
    if not page.endswith('.png'):
        raise SystemExit(f'Unexpected atlas page name: {page}')
    return 'occlusion-' + page


def build(root: Path, check: bool) -> int:
    bundle_path = root / 'bundle.json'
    bundle = json.loads(bundle_path.read_text(encoding='utf-8'))
    pages = {}
    for package in bundle['packages']:
        for page in package['pages']:
            known = pages.setdefault(page['file'], page['size'])
            if known != page['size']:
                raise SystemExit(f'Inconsistent page size for {page["file"]}')
    manifest = {'version': 1, 'bundleSHA256': sha256(bundle_path), 'pages': {}}
    for name in sorted(pages):
        source = Image.open(root / name)
        if source.mode != 'RGBA' or list(source.size) != pages[name]:
            raise SystemExit(f'{name}: expected RGBA {pages[name]}, found {source.mode} {list(source.size)}')
        alpha = source.getchannel('A')
        # L=0 with the original alpha: identical to the scene's black-silhouette filter output.
        target = root / occlusion_name(name)
        mask = Image.merge('LA', (Image.new('L', source.size, 0), alpha))
        if not check:
            mask.save(target, optimize=True)
        elif not target.exists() or Image.open(target).getchannel('A').tobytes() != alpha.tobytes():
            raise SystemExit(f'{target.name} is missing or does not match {name}')
        manifest['pages'][name] = {'file': target.name, 'sha256': sha256(target), 'size': pages[name]}
    text = json.dumps(manifest, indent=2) + '\n'
    out = root / 'occlusion.json'
    if check:
        if not out.exists() or out.read_text(encoding='utf-8') != text:
            raise SystemExit('occlusion.json is stale; rebuild the occlusion pages')
    else:
        out.write_text(text, encoding='utf-8', newline='\n')
    total = sum((root / page['file']).stat().st_size for page in manifest['pages'].values())
    print(f'{len(manifest["pages"])} occlusion pages, {total / 1048576:.1f} MiB, bundle {manifest["bundleSHA256"][:12]}')
    return 0


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--check'):
        raise SystemExit(__doc__)
    sys.exit(build(Path(sys.argv[1]), len(sys.argv) == 3))
