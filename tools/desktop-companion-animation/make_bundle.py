#!/usr/bin/env python3
"""Collect explicit authored packages into a flat local-file bundle; never promote review status."""
import argparse
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('inventory', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
rows = json.loads(args.inventory.read_text())
args.output.mkdir(parents=True, exist_ok=True)
packages = []
ids = set()
for index, row in enumerate(rows):
    source = (args.inventory.parent / row['package']).resolve()
    package = json.loads(source.read_text())
    if package['id'] in ids:
        raise ValueError('Duplicate sequence identity; bind one explicit action per package')
    ids.add(package['id'])
    package['action'] = row.get('action', package.get('action'))
    for page_index, page in enumerate(package['pages']):
        origin = (source.parent / page['file']).resolve()
        if not origin.is_relative_to(source.parent):
            raise ValueError('Atlas escapes source package')
        name = f'action-{index:03d}-atlas-{page_index:03d}.png'
        shutil.copy2(origin, args.output / name)
        page['file'] = name
        page.pop('image', None)
    packages.append(package)
(args.output / 'bundle.json').write_text(json.dumps({'version': 1, 'packages': packages}, ensure_ascii=False, indent=2) + '\n')
print(f'Bundled {len(packages)} actual packages; all original acceptance statuses preserved')
