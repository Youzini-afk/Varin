#!/usr/bin/env python3
"""Package explicit pickup/release drawings as small nodes consumed by the shared player.
No inference from family names, interpolation, acceptance promotion or pose substitution.
"""
import argparse,hashlib,json,shutil,copy
from pathlib import Path
from pack_sequence import pack

p=argparse.ArgumentParser(description=__doc__);p.add_argument('contract',type=Path);p.add_argument('source_root',type=Path);p.add_argument('output',type=Path);p.add_argument('--acceptance',type=Path);a=p.parse_args()
root=a.source_root.resolve();spec=json.loads(a.contract.read_text());approved=json.loads(a.acceptance.read_text()) if a.acceptance else {};core=set(approved.get('coreNodes',[]));entries=set(approved.get('entrySourceSha256',[]));a.output.mkdir(parents=True,exist_ok=True)
nodes={};prefix='relocation.'
# Resume interrupted exports and encode each identical drawing only once.
image_templates={}
for existing in a.output.glob('*/sequence.json'):
 try:
  value=json.loads(existing.read_text())
  if len(value.get('frames',[]))==1 and all((existing.parent/page['file']).is_file() for page in value['pages']):
   image_templates.setdefault(value['frames'][0]['sha256'],(existing.parent,value))
 except (ValueError,KeyError):pass
def core_id(name):return prefix+'node.'+name
def checked_source(source,sha=None):
 path=(root/source).resolve()
 if not path.is_relative_to(root):raise ValueError('Drawing escapes production root')
 actual=hashlib.sha256(path.read_bytes()).hexdigest()
 if sha and actual!=sha:raise ValueError(f'Frozen source SHA changed: {source}')
 return path,actual

def add_node(id,source,duration,gesture,accepted=False,sha=None):
 path,digest=checked_source(source,sha);folder=a.output/id;folder.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,folder/'source.png')
 pose='seated-closed-neutral-rest' if gesture['settled'] else id
 data={'id':id,'canvas':[512,512],'stage':'motion-candidate','reviewStatus':'accepted' if accepted else 'candidate','geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','kind':'gesture-node','entryPose':pose,'exitPose':pose,'frames':[{'source':'source.png','durationMs':duration,'offset':[0,0],'pose':pose}],'loop':None,'warning':'Authored pointer-local movement only; native root follows immediately, never an execution state.'}
 (folder/'sequence.source.json').write_text(json.dumps(data,indent=2)+'\n')
 if digest in image_templates:
  template_dir,template=image_templates[digest];out=copy.deepcopy(template)
  for page in out['pages']:
   if template_dir!=folder:shutil.copyfile(template_dir/page['file'],folder/page['file'])
  for key in ['id','canvas','stage','reviewStatus','geometryReference','kind','entryPose','exitPose','loop','warning']:out[key]=data[key]
  out['durationMs']=duration;out['frames'][0].update(durationMs=duration,startMs=0,pose=pose)
 else:
  out=pack(folder/'sequence.source.json',folder);image_templates[digest]=(folder,out)
 out['gesture']=gesture
 (folder/'sequence.json').write_text(json.dumps(out,indent=2)+'\n');nodes[id]={'package':str((folder/'sequence.json').resolve()),'source':source,'sourceSha256':digest,'accepted':accepted}

for name,f in spec['frames'].items():
 add_node(core_id(name),f['source'],f['durationMs'],{'grabNext':[core_id(x) for x in f['grabNext']],'releaseNext':[core_id(x) for x in f['releaseNext']],'embeddedStool':f['embeddedStool'],'settled':name=='seated','restoreOnRelease':False},name in core,f.get('sha256'))
seen=set()
for entry in spec['currentPoseEntries']:
 sha=entry['sourceSha256']
 if sha in seen:raise ValueError('Duplicate current-source SHA must be resolved by the art contract, not last-wins')
 seen.add(sha);checked_source(entry['source'],sha)
 recovery=entry['recoveryFrames'];ids=[prefix+'recovery.'+sha+'.'+str(i) for i in range(len(recovery))];carry=[core_id(x) for x in entry['carryAfterRecovery']];release=[core_id(x) for x in entry['releaseAfterRecovery']]
 # Each real recovery drawing knows both authored continuations; release never enters curl/hug first.
 for i,frame in enumerate(recovery):
  if frame.get('originalSeatedSource'): checked_source(frame['originalSeatedSource'],frame.get('originalSeatedSha256'))
  add_node(ids[i],frame['source'],frame['durationMs'],{'grabNext':ids[i+1:]+carry,'releaseNext':ids[i+1:]+release,'embeddedStool':False,'settled':False,'restoreOnRelease':False,**({'restoreSourceSha256':frame['originalSeatedSha256']} if frame.get('originalSeatedSha256') else {})},sha in entries,frame.get('sha256'))
 add_node(prefix+'entry.'+sha,entry['detachedSource'],entry['currentFrameMs'],{'entrySourceSha256':sha,'grabNext':ids+carry,'releaseNext':[],'embeddedStool':False,'settled':False,'restoreOnRelease':True},sha in entries,entry['detachedSha256'])
for name,row in nodes.items():
 d=json.loads(Path(row['package']).read_text())
 for target in d['gesture']['grabNext']+d['gesture']['releaseNext']:
  if target not in nodes:raise ValueError(f'{name}: missing continuation {target}')
(a.output/'inventory.json').write_text(json.dumps([{'package':str(Path(row['package']).relative_to(a.output.resolve())),'action':None} for row in nodes.values()],indent=2)+'\n')
(a.output/'provenance.json').write_text(json.dumps({'contractSha256':hashlib.sha256(a.contract.read_bytes()).hexdigest(),'acceptanceFile':str(a.acceptance) if a.acceptance else None,'nodes':nodes},indent=2)+'\n')
print(f'{len(nodes)} small authored nodes; {len(seen)} exact current-exposure entries. Acceptance preserved from explicit ledger only.')
