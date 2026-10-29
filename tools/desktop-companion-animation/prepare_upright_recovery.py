"""Compile supplied actual drawing recovery paths, without promoting acceptance."""
import hashlib,json,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);args=parser.parse_args()
R=args.root.resolve();out={};sources={}
def step(path,ms):
 p=R/path;h=hashlib.sha256(p.read_bytes()).hexdigest();sources[h]=str(p.relative_to(R));return {'source':str(p.relative_to(R)),'sha256':h,'durationMs':ms,'cue':'RECOVERY_ONLY'}
def add(h,first,steps):
 sources[h]=first
 out[h]={'source':first,'steps':steps,'scope':'real-source recovery candidate; no receipt or scene action cue'}
q=json.loads((R/'question-permission-integration-support/ordinary-recovery-by-source-sha.json').read_text())
for h,r in q['routes'].items():add(h,r['source'],[step(f['source'],f['durationMs']) for f in r['steps']])
e=json.loads((R/'integration/edit-dispatch-recovery/recovery-by-source-sha.json').read_text())
for r in e['routes']:
 if r['fromSourceSHA256'] not in out:add(r['fromSourceSHA256'],r['fromFrame'],[step(f['frame'],f['holdMs']) for f in r['recovery']])
r=json.loads((R/'reading-search/runtime-handoff.json').read_text())
for s in r['sequences'].values():
 for i,indices in s['safeRecoveryFromActualFrame'].items():
  f=s['frames'][int(i)];h=f['sha256']
  if h not in out:add(h,'reading-search/'+f['source'],[step('reading-search/'+s['frames'][j]['source'],min(s['frames'][j]['durationMs'],140)) for j in indices[1:]])
l=json.loads((R/'lid/sequence-source-v3.json').read_text())
for i,f in enumerate(l['closing']):
 if f['sha256'] not in out:add(f['sha256'],'lid/'+f['source'],[step('lid/'+g['source'],min(g['durationMs'],140)) for g in l['closing'][i+1:]])
# Already neutral canonical eyes/hands need no extra action replay.
for p in ['shared/upright-open-neutral-v2.png','shared/open-screen-read-v2.png','lid/frames/closed-rest-rigid-v2.png']:
 f=step(p,100);add(f['sha256'],p,[])
quiet=json.loads((R/'closed-idle/manifest.json').read_text())
for i,indices in quiet['safeRecoveryFromActualExposure'].items():
 f=quiet['frames'][int(i)];h=f['sha256']
 if h not in out:
  ms=quiet['safeRecoveryExposureOverridesMs'][i]
  add(h,'closed-idle/'+f['source'],[step('closed-idle/'+quiet['frames'][j]['source'],ms[k]) for k,j in enumerate(indices) if k>0])
inventory=json.loads((R/'integration/inventory.json').read_text())
used={f['sha256'] for seq in inventory['sequences'] if seq['id']!='relocation-core' for f in seq['frames']}
out={h:route for h,route in out.items() if h in used}
sources={h:path for h,path in sources.items() if h in used}
idx=json.loads((R/'relocation/current-source-detached-index-v4.json').read_text());mapped={e['sourceSHA256'] for e in idx['entries']}
missing=[{'sha256':h,'source':p} for h,p in sources.items() if h not in mapped]
(R/'integration/recovery-by-source.json').write_text(json.dumps({'routes':out,'allActualSources':sources,'detachedMissing':missing,'timingNote':'Reading and lid recovery-only holds capped at140ms; actual drawings unchanged, this timing remains integration-review candidate.'},indent=2)+'\n')
print('routes',len(out),'actual sources',len(sources),'detached missing',len(missing))
