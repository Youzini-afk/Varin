"""Source/graph invariants for the explicit candidate branch; no art acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from PIL import Image
from compile_upright_pickup import compile_explicit_baseline

ROOT = Path(__file__).resolve().parents[2]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


class ExplicitBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.s, self.d = self.root / 'seat.png', self.root / 'body.png'
        # Synthetic pixels test compiler integrity only, never a selected skin.
        Image.new('RGBA', (512, 512), (30, 80, 140, 255)).save(self.s)
        Image.new('RGBA', (512, 512), (60, 90, 170, 255)).save(self.d)
        self.sh, self.dh = sha(self.s), sha(self.d)
        plate = ROOT / 'docs/design/desktop-companion-assets/animation-source/production-v2/relocation/frames/world-stool-grounded-v4.png'
        self.data = {'version': 1, 'canvas': [512, 512], 'geometryReference': 'test-only',
                     'canonicalSources': {self.sh: 'test:rest'},
                     'worldStool': {'source': str(plate), 'sourceSHA256': sha(plate)},
                     'counterparts': [{'sourceSHA256': self.sh, 'detachedSHA256': self.dh}],
                     'sequences': [{'id': 'rest', 'kind': 'action', 'action': 'external-wait', 'loop': [0, 1],
                                    'frames': [{'source': str(self.s), 'sourceSHA256': self.sh, 'durationMs': 100, 'exitSafe': True, 'cue': 'ACCEPT_INWARD'}]}],
                     'nodes': [
                         {'id': 'body', 'source': str(self.d), 'sourceSHA256': self.dh, 'durationMs': 10,
                          'gesture': {'entrySourceSha256': self.sh, 'grabNext': [], 'releaseNext': ['seat'],
                                      'embeddedStool': False, 'settled': False, 'restoreOnRelease': False, 'releaseViaFrames': True}},
                         {'id': 'seat', 'source': str(self.s), 'sourceSHA256': self.sh, 'durationMs': 10,
                          'gesture': {'grabImmediate': 'body', 'grabNext': [], 'releaseNext': [],
                                      'embeddedStool': True, 'settled': True, 'restoreOnRelease': False}}]}

    def build(self, data=None):
        path = self.root / 'source.json'
        path.write_text(json.dumps(data or self.data))
        return compile_explicit_baseline(path, self.root / 'out')

    def test_actual_player_roundtrip_and_no_legacy_art(self):
        receipt = self.build()
        self.assertEqual(receipt['actualSources'], sorted([self.sh, self.dh]))
        self.assertFalse(receipt['legacyAssetsCopied'])
        script = """
import fs from 'node:fs'; import assert from 'node:assert/strict';
import {CompanionPlayback} from PLAYER;
const bundle=JSON.parse(fs.readFileSync(BUNDLE));
assert.ok(bundle.packages.every(p=>p.reviewStatus==='candidate'));
assert.equal(bundle.packages.find(p=>p.id==='rest').frames[0].cue,'ACCEPT_INWARD');
const p=new CompanionPlayback(bundle.packages,{allowCandidates:true});
p.request('rest'); assert.equal(p.grab(),true); assert.equal(p.current.id,'body');
p.release(); p.tick(10); assert.equal(p.current.id,'seat');
p.grab(); assert.equal(p.current.id,'body');
p.request('rest',{context:'new'}); p.release(); p.tick(100);
assert.equal(p.gesture,null); assert.equal(p.current.id,'rest'); assert.equal(p.currentContext,'new');
""".replace('PLAYER', json.dumps((ROOT / 'packages/ui/src/components/companion/playback.mjs').as_uri())).replace('BUNDLE', json.dumps(str(self.root / 'out/bundle.json')))
        subprocess.run(['node', '--input-type=module', '-e', script], check=True)

    def test_explicit_endpoints_bind_only_actual_canonical_sources(self):
        c, d = self.root / 'closed.png', self.root / 'closed-body.png'
        Image.new('RGBA', (512, 512), (40, 90, 170, 255)).save(c)
        Image.new('RGBA', (512, 512), (50, 90, 180, 255)).save(d)
        ch, dh = sha(c), sha(d)
        self.data['canonicalSources'][ch] = 'test:closed'
        self.data['counterparts'].append({'sourceSHA256': ch, 'detachedSHA256': dh})
        self.data['sequences'].append({'id': 'closed', 'kind': 'action', 'action': 'idle-closed', 'frames': [{'source': str(c), 'sourceSHA256': ch, 'durationMs': 100}]})
        self.data['nodes'] += [
            {'id': 'closed-body', 'source': str(d), 'sourceSHA256': dh, 'durationMs': 10, 'gesture': {'entrySourceSha256': ch, 'grabNext': [], 'releaseNext': ['closed-seat'], 'embeddedStool': False, 'settled': False, 'restoreOnRelease': False, 'releaseViaFrames': True}},
            {'id': 'closed-seat', 'source': str(c), 'sourceSHA256': ch, 'durationMs': 10, 'gesture': {'grabImmediate': 'closed-body', 'grabNext': [], 'releaseNext': [], 'embeddedStool': True, 'settled': True, 'restoreOnRelease': False}}]
        self.data['endpoints'] = {'geometryReference': 'test-only', 'open': {'pose': 'test:rest', 'sourceSha256': self.sh}, 'closed': {'pose': 'test:closed', 'sourceSha256': ch}, 'closedSourceSha256': [ch]}
        bad = copy.deepcopy(self.data); bad['endpoints']['closed']['sourceSha256'] = self.sh
        with self.assertRaises(ValueError): self.build(bad)
        self.assertFalse((self.root / 'out').exists())
        self.build()
        self.assertEqual(json.loads((self.root / 'out/bundle.json').read_text())['endpoints'], self.data['endpoints'])

    def test_bad_source_or_graph_rejected_before_output(self):
        cases = [
            lambda d: d['counterparts'].clear(),
            lambda d: d['nodes'][0]['gesture'].update(entrySourceSha256='0' * 64),
            lambda d: d['nodes'][0]['gesture'].update(releaseNext=['missing']),
            lambda d: d['nodes'][0]['gesture'].update(releaseNext=[]),
            lambda d: d['nodes'][1]['gesture'].update(grabImmediate='seat'),
            lambda d: d['nodes'][0].update(sourceSHA256='0' * 64),
            lambda d: d['nodes'].append({**copy.deepcopy(d['nodes'][0]), 'id': 'duplicate-entry'}),
            lambda d: d.update(geometryReference='varin-upright-v2'),
        ]
        for change in cases:
            with self.subTest(change=change):
                data = copy.deepcopy(self.data); change(data)
                with self.assertRaises(ValueError): self.build(data)
                self.assertFalse((self.root / 'out').exists())


if __name__ == '__main__':
    unittest.main()
