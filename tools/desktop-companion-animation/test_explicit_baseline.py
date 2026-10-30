"""Source/graph invariants for the explicit candidate branch; no art acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from PIL import Image
from compile_upright_pickup import atlas_source_order, compile_explicit_baseline

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

    def test_atlas_author_order_is_opt_in_and_exact(self):
        sources = {self.sh: self.s, self.dh: self.d}
        legacy = sorted(sources)
        self.assertEqual(atlas_source_order({}, sources), legacy)
        authored = list(reversed(legacy))
        self.assertEqual(atlas_source_order({'atlasSourceOrder': authored}, sources), authored)
        self.build()
        self.assertEqual([f['sha256'] for f in json.loads((self.root / 'out/sequence.json').read_text())['frames']], legacy)
        ordered = {**self.data, 'atlasSourceOrder': authored}
        path = self.root / 'ordered.json'; path.write_text(json.dumps(ordered))
        compile_explicit_baseline(path, self.root / 'ordered-out')
        self.assertEqual([f['sha256'] for f in json.loads((self.root / 'ordered-out/sequence.json').read_text())['frames']], authored)
        def semantics(path):
            bundle = json.loads(path.read_text())
            for package in bundle['packages']:
                package.pop('pages')
                for frame in package['frames']:
                    frame.pop('page'); frame.pop('rect')
            return bundle
        self.assertEqual(semantics(self.root / 'out/bundle.json'), semantics(self.root / 'ordered-out/bundle.json'))
        for bad in [None, 'invalid', [], [self.sh], [self.sh, self.sh],
                    [self.sh, '0' * 64], [self.sh, self.dh, '0' * 64], [[], self.sh]]:
            with self.subTest(order=bad), self.assertRaisesRegex(ValueError, 'exactly once'):
                atlas_source_order({'atlasSourceOrder': bad}, sources)

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

    def test_portable_preparation_rebuilds_declared_bytes_and_rejects_stale_recipe(self):
        from pack_sequence import prepare_seated
        recipe = {'version': 1, 'worldStool': {'source': self.data['worldStool']['source'], 'sha256': self.data['worldStool']['sourceSHA256']},
                  'frames': [{'id': 'pose', 'source': 'seat.png', 'sha256': self.sh, 'detached': {'source': 'body.png', 'sha256': self.dh}}]}
        recipe_path = self.root / 'recipe.json'; recipe_path.write_text(json.dumps(recipe))
        prepare_seated(recipe_path, self.root / 'reference')
        sh, dh = sha(self.root / 'reference/pose-ordinary.png'), sha(self.root / 'reference/pose-detached.png')
        data = json.loads(json.dumps(self.data).replace(self.sh, sh).replace(self.dh, dh))
        for row in [*data['nodes'], *data['sequences'][0]['frames']]:
            row['source'] = 'prepared/pose-' + ('ordinary.png' if row['sourceSHA256'] == sh else 'detached.png')
        data['sourcePreparation'] = {'recipe': 'recipe.json', 'recipeSHA256': sha(recipe_path), 'detachedOnly': []}
        portable = self.root / 'portable.json'; portable.write_text(json.dumps(data))
        receipt = compile_explicit_baseline(portable, self.root / 'portable-out')
        self.assertEqual(receipt['actualSources'], sorted([sh, dh]))
        self.assertFalse(receipt['sourceRebuild']['historicalPreparedInputs'])
        self.assertIn('pillowVersion', receipt['sourceRebuild'])
        # The isolated selector binds actual compiler/preparation evidence, not an old skin.
        # An incomplete artifact-bound review must be rejected before output.
        candidate = self.root / 'portable-out/bundle.json'
        review = self.root / 'review.json'
        review.write_text(json.dumps({'candidateSHA256': sha(candidate)}))
        selected = self.root / 'selected'
        result = subprocess.run(['python', str(ROOT / 'tools/desktop-companion-animation/select_interaction_bundle.py'),
                                 str(candidate), str(selected), '--explicit-baseline', str(portable),
                                 '--build-receipt', str(candidate.parent / 'build-receipt.json'),
                                 '--rebuild-receipt', str(self.root / 'portable-out-prepared/rebuild-receipt.json'),
                                 '--review-record', str(review)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('binding mismatch', result.stderr)
        self.assertFalse(selected.exists())
        with self.assertRaisesRegex(ValueError, 'fresh output'):
            compile_explicit_baseline(portable, self.root / 'portable-out')
        recipe_path.write_text(json.dumps({**recipe, 'changed': True}))
        with self.assertRaisesRegex(ValueError, 'recipe SHA'):
            compile_explicit_baseline(portable, self.root / 'stale-out')
        self.assertFalse((self.root / 'stale-out').exists())

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
