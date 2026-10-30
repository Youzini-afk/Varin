"""Prepare source-only v2 inventory; never promote art or overwrite product assets."""
import hashlib,json,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);args=parser.parse_args()
ROOT=args.root.resolve()
WORK=ROOT.parent
OUT=ROOT/'integration'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
shared=json.loads((ROOT/'shared/source-manifest.json').read_text())
sequences=[]; issues=[]

def add(name,path,frames,resolve):
    result=[]
    for i,f in enumerate(frames):
        p=resolve(f).resolve()
        if not p.is_file():
            issues.append({'sequence':name,'frame':i,'missing':str(p)});continue
        digest=sha(p)
        if f.get('sha256') and f['sha256']!=digest:
            issues.append({'sequence':name,'frame':i,'reason':'source SHA mismatch'})
        result.append({'source':str(p.relative_to(WORK)),'sha256':digest,'durationMs':f.get('durationMs'),'cue':f.get('cue',f.get('phase')),'eventHold':f.get('durationMs') is None})
    sequences.append({'id':name,'sourceManifest':str(path.relative_to(WORK)),'manifestSha256':sha(path),'reviewStatus':'candidate-not-promoted','frames':result})

lid=ROOT/'lid/sequence-source-v3.json'
for name,frames in json.loads(lid.read_text()).items():
    if name in ('opening','closing'):add('lid-'+name,lid,frames,lambda f:lid.parent/f['source'])
qp=ROOT/'question-permission/manifest.json'; q=json.loads(qp.read_text())
for name,frames in q['sequences'].items():
    add(name,qp,frames,lambda f:qp.parent/(q['assets'][f['pose']]['path'] if f['pose'] in q['assets'] else f['pose']))
for family in ['reading','search']:
    p=ROOT/'reading-search'/f'{family}-timing-v2.json'
    add(family,p,json.loads(p.read_text())['frames'],lambda f:p.parent/f['source'])
ed=ROOT/'editing-dispatch/sequence-manifest.json'
for name,sequence in json.loads(ed.read_text())['sequences'].items():
    frames=[{'source':f['frame'],'durationMs':f['holdMs'],'sha256':f['sourceSHA256'],'cue':f['cue']} for f in sequence['frames']]
    add(name,ed,frames,lambda f:ed.parent/f['source'])
wave=ROOT/'question-permission/wave/manifest.json'
for name,sequence in json.loads(wave.read_text())['semantics'].items():
    frames=[{'source':f['path'],'durationMs':f['durationMs'],'cue':f['cue']} for f in sequence['frames']]
    add('local-'+name,wave,frames,lambda f:wave.parent.parent/f['source'])
core=ROOT/'relocation/core-transition-contract-v3.json'
coreNodes=json.loads(core.read_text())['nodes']
add('relocation-core',core,[{'source':coreNodes[name]['source'],'sha256':coreNodes[name]['sourceSHA256'],'durationMs':100,'cue':'RECOVERY_ONLY'} for name in ['closedSeated','midSeated','secureSeated','contactSeated','airborneNeutral','airborneResponse']],lambda f:core.parent/f['source'])
gaze=ROOT/'reading-search/gaze-bridge/source-sequences.json'
for sequence in json.loads(gaze.read_text())['sequences']:
    add(sequence['id'],gaze,sequence['frames'],lambda f:gaze.parent.parent/f['source'])
blink=ROOT/'question-permission/blink/manifest.json'
add('waiting-blink',blink,[{'source':n,'durationMs':ms,'cue':'ATTEND'} for n,ms in [('listen-rest-half.png',45),('listen-rest-closed.png',75),('listen-rest-half.png',45)]],lambda f:blink.parent/f['source'])
local=ROOT/'question-permission/local-closures/manifest.json'
add('local-open-tap',local,[{'source':f['path'],'durationMs':f['durationMs'],'cue':f['cue']} for f in json.loads(local.read_text())['openTap']['frames']],lambda f:local.parent.parent/f['source'])
quiet=ROOT/'closed-idle/manifest.json'
add('closed-idle',quiet,json.loads(quiet.read_text())['frames'],lambda f:quiet.parent/f['source'])
anchors={name:sha(ROOT/file) for name,file in {'open-user':'shared/upright-open-neutral-v2.png','open-screen':'shared/open-screen-read-v2.png','closed':'lid/frames/closed-rest-rigid-v2.png'}.items()}
for s in sequences:
    for label,frame in [('entry',s['frames'][0]),('exit',s['frames'][-1])]:
        s[label+'Anchor']=next((name for name,h in anchors.items() if h==frame['sha256']),None)
    s['requiresContract']=['authored safe-exit points','loop bounds or finite declaration','source-specific pickup route','finite visual review scope']
if issues:raise SystemExit(json.dumps({'sourceIssues':issues},ensure_ascii=False))
unique={f['sha256']:f['source'] for s in sequences for f in s['frames']}
inventory={'stage':'source staging only; no runtime acceptance','geometryReference':'varin-upright-v2','sequences':sequences,'uniqueSourceCount':len(unique),'uniqueSources':unique,'sourceIssues':issues}
(OUT/'inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sequences':len(sequences),'uniqueSources':len(unique),'sourceIssues':issues}))
