"""Focused source preparation tests; no visual acceptance or selected-bundle build."""
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path
import tempfile
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location('pack_sequence', Path(__file__).with_name('pack_sequence.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PLATE = Path(__file__).resolve().parents[2] / 'docs/design/desktop-companion-assets/animation-source/production-v2/relocation/frames/world-stool-grounded-v4.png'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


class PrepareSeatedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fg = self.root / 'foreground.png'
        Image.new('RGBA', (1254, 1254), (50, 90, 130, 100)).save(self.fg)
        self.body = self.root / 'pickup.png'
        Image.new('RGBA', (512, 512), (10, 40, 70, 150)).save(self.body)
        self.manifest = self.root / 'source.json'
        shutil.copyfile(PLATE, self.root / 'plate.png')
        self.data = {'version': 1, 'worldStool': {'source': 'plate.png', 'sha256': sha(PLATE)},
                     'frames': [{'id': 'neutral', 'source': self.fg.name, 'sha256': sha(self.fg),
                                 'detached': {'source': self.body.name, 'sha256': sha(self.body)}}]}

    def prepare(self, output='prepared'):
        self.manifest.write_text(json.dumps(self.data))
        return module.prepare_seated(self.manifest, self.root / output)

    def test_reproducible_and_actual_composite_pickup_key(self):
        a = self.prepare('a'); b = self.prepare('b')
        self.assertEqual(a, b)
        # Identical relative manifests remain reproducible in another checkout root.
        with tempfile.TemporaryDirectory() as elsewhere:
            other = Path(elsewhere)
            for name in ('source.json', 'plate.png', 'foreground.png', 'pickup.png'):
                shutil.copyfile(self.root / name, other / name)
            relocated = module.prepare_seated(other / 'source.json', other / 'prepared')
            self.assertEqual(a, relocated)
            for file in (self.root / 'a').iterdir():
                self.assertEqual(file.read_bytes(), (other / 'prepared' / file.name).read_bytes())
        row = a['frames'][0]
        actual = sha(self.root / 'a' / row['source'])
        self.assertEqual(actual, row['sourceSHA256'])
        self.assertNotEqual(actual, row['foreground']['sha256'])
        index = json.loads((self.root / 'a/detached-index.json').read_text())['entries'][0]
        self.assertEqual(actual, index['sourceSHA256'])
        self.assertEqual(sha(self.root / 'a' / index['detachedSource']), index['detachedSHA256'])
        with Image.open(PLATE) as plate, Image.open(self.fg) as fg, Image.open(self.root / 'a' / row['source']) as output:
            expected = Image.alpha_composite(plate, fg.resize((512, 512), Image.Resampling.LANCZOS))
            self.assertEqual(expected.tobytes(), output.tobytes())

    def test_bad_input_sha_refused_before_output(self):
        self.data['frames'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA mismatch'):
            self.prepare()
        self.assertFalse((self.root / 'prepared').exists())

    def test_valid_hash_but_wrong_plate_refused(self):
        self.data['worldStool'] = {'source': str(self.body), 'sha256': sha(self.body)}
        with self.assertRaisesRegex(ValueError, 'frozen original'):
            self.prepare()

    def test_missing_pickup_stays_explicitly_missing(self):
        del self.data['frames'][0]['detached']
        result = self.prepare()
        self.assertEqual(result['frames'][0]['pickupStatus'], 'missing-authored-counterpart')
        self.assertEqual(json.loads((self.root / 'prepared/detached-index.json').read_text())['entries'], [])

    def test_wrong_size_refused(self):
        Image.new('RGBA', (640, 512)).save(self.fg)
        self.data['frames'][0]['sha256'] = sha(self.fg)
        with self.assertRaisesRegex(ValueError, 'full 512 or 1254'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
