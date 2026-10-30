from pathlib import Path
import json,hashlib
root=Path(__file__).parent.parent;r=root/'relocation';selected=set();external=set()
report=json.loads((r/'portable-rebuild-verification-v1.json').read_text())
for x in report['results']:selected.add(x['path'])
scripts={'lid':['prepare_crops.py','build_prop_fixture.py','register_contacts_v2.py','compose_endpoints_and_review.py','add_release_bridge.py','fix_closed_hand_layers.py','fix_contact_hand_layers.py'],'relocation':['register_secure.py','register_detach.py','register_airborne_response.py','fix_secure_hand_layers.py','register_land_contact.py','register_lap_release.py','register_stool.py','register_stool_v2.py','align_stool_geometry.py','finish_stool_legs.py','register_no_stool_v3.py','register_contact_no_stool_v2.py','prepare_no_stool_donor.py','derive_core_no_stool.py','derive_airborne_lid.py','refine_stool_mask.py','derive_airborne_lid_v2.py','derive_lid_contact_support.py','build_core_contract_v3.py','derive_ordinary_current_sources_v2.py','append_closed_idle_sources.py','apply_foreground_tail_cleanup.py','compose_core_review_v2.py','freeze_current_art_selection.py']}
raws={'lid':['contact-000-v2','contact-015-crop-v2','contact-020-v1','contact-045-v1','contact-055-v1','contact-070-v1','contact-100-v1','no-laptop-cleanplate-v1','release-first-crop-v1','release-low-crop-v2','release-near-cleanup-v2'],'relocation':['seated-secure-v1','detach-first-v1','airborne-settle-v1','land-contact-v1','lap-release-mid-v1','secure-no-stool-v1','contact-no-stool-v1','stool-plate-v1','stool-repair-v2','stool-ground-plane-v4']}
for family,names in scripts.items():
 for n in names:selected.add(f'{family}/{n}')
for family,names in raws.items():
 for n in names:
  selected.add(f'{family}/sources/{n}-raw.png');selected.add(f'{family}/sources/{n}-prompt.txt')
for p in ['lid/README.md','lid/sequence-source-v3.json','lid/prop-geometry.json','lid/closed-rest-v2-provenance.json','relocation/REBUILD.md','relocation/closed-reference.png','relocation/ordinary-source-inventory-snapshot-v1.json','relocation/core-transition-contract-v3.json','relocation/current-source-detached-index-v4.json','relocation/lid-support-bridge-v1.json','relocation/lid-airborne-contact-sources-v3.json','relocation/portable-rebuild-verification-v1.json']:
 selected.add(p)
# Per-source masks are useful independent evidence, not required to decode runtime PNGs.
idx=json.loads((r/'current-source-detached-index-v4.json').read_text())
for e in idx['entries']:
 selected.add('relocation/'+e['mask']);external.add(str(Path(e['source']).relative_to('varin-animation-production-v2')))
for p in ['shared/upright-open-neutral-v2.png','shared/closed-neutral-v1.png','closed-idle/manifest.json']:
 external.add(p)
for name in ['question-permission-integration-support','integration/dispatch-foreground-protection']:
 for p in (root/name).rglob('*'):
  if p.is_file() and p.suffix in ['.png','.json','.py']:external.add(str(p.relative_to(root)))
# External folders already belong to the other portable art packages; list exact dependency hashes.
def rec(paths):
 out=[]
 for p in sorted(paths):
  f=root/p
  if not f.exists():raise RuntimeError('Missing '+p)
  out.append({'path':p,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 return out
j={'stage':'current recoverable art-source selection; excludes rejected historical generations and bulky review movies','pathBase':'varin-animation-production-v2','selectedFiles':rec(selected),'externalRequiredFiles':rec(external-selected),'rebuildVerification':'relocation/portable-rebuild-verification-v1.json','note':'55 ordinary current-source images and 91 final consumed PNGs byte-verified after deleting outputs in an independent rebuild; native behavior remains integration owner responsibility'}
(r/'CURRENT_ART_SOURCE_SELECTION_V4.json').write_text(json.dumps(j,indent=2)+'\n');print(len(j['selectedFiles']),sum(x['bytes'] for x in j['selectedFiles']),len(j['externalRequiredFiles']))
