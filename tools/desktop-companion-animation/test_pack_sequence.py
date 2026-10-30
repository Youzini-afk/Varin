"""Actual PNG/placement regression for duplicate sources spanning atlas pages."""
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from pack_sequence import pack


class PackSequenceTests(unittest.TestCase):
    def test_dedup_and_multiple_pages_retain_exact_png_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            colors = [(210, 30, 40, 255), (20, 190, 60, 255), (40, 50, 220, 255)]
            for index, color in enumerate(colors):
                # Transparent registration border must become offset, not altered art.
                with Image.new('RGBA', (8, 8)) as source:
                    source.paste(color, (1, 1, 7, 7))
                    source.save(root / f'{index}.png')
            manifest = root / 'source.json'
            manifest.write_text(json.dumps({
                'id': 'deduplicated-multi-page', 'canvas': [8, 8], 'loop': [0, 5],
                'frames': [{'source': f'{i}.png', 'durationMs': 70}
                           for i in [0, 1, 0, 2, 1]],
            }))
            output = root / 'packed'
            result = pack(manifest, output, max_size=16, padding=2)
            self.assertEqual(result['uniqueImages'], 3)
            self.assertEqual(result['durationMs'], 350)
            self.assertEqual(result['loop'], [0, 5])
            self.assertEqual([f['page'] for f in result['frames']], [0, 1, 0, 2, 1])
            self.assertEqual([f['rect'] for f in result['frames']], [[2, 2, 6, 6]] * 5)
            self.assertEqual([f['offset'] for f in result['frames']], [[1, 1]] * 5)
            for index, color in enumerate(colors):
                # Independent exact expected atlas: 6-square plus 2px extruded gutters.
                # Encode with the same installed Pillow version, without a second packer.
                expected = io.BytesIO()
                with Image.new('RGBA', (10, 10), color) as atlas:
                    atlas.save(expected, format='PNG')
                self.assertEqual((output / f'atlas-{index:03d}.png').read_bytes(), expected.getvalue())
            self.assertEqual(json.loads((output / 'sequence.json').read_text()), result)


    def test_invalid_late_input_produces_no_partial_atlas(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with Image.new('RGBA', (8, 8), (210, 30, 40, 255)) as source:
                source.save(root / 'source.png')
            for invalid_frame, loop in [({'durationMs': 0}, [0, 2]), ({'durationMs': 70}, [0, 3])]:
                with self.subTest(invalid_frame=invalid_frame, loop=loop):
                    manifest = root / 'source.json'
                    manifest.write_text(json.dumps({
                        'id': 'invalid-tail', 'canvas': [8, 8], 'loop': loop,
                        'frames': [{'source': 'source.png', 'durationMs': 70},
                                   {'source': 'source.png', **invalid_frame}],
                    }))
                    output = root / 'must-not-exist'
                    with self.assertRaises(ValueError):
                        pack(manifest, output, max_size=16, padding=2)
                    self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
