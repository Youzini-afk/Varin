from pathlib import Path
import json,hashlib
r=Path(__file__).parent;o=r/'transition-contract-v6';o.mkdir(exist_ok=True);c=json.loads((r/'transition-contract-v5/relocation.source.json').read_text())
for entry in c['currentPoseEntries']:
 seq=[]
 for item in entry.get('grabNext',[]):
  source=item.get('source','')
  if '/family-detach-v1/' in source:
   mid=source.replace('/family-detach-v1/','/family-midreach-v1/');seq.append({'source':mid,'sha256':hashlib.sha256((r.parent/mid).read_bytes()).hexdigest(),'durationMs':45})
  seq.append(item)
 entry['grabNext']=seq
c['acceptance']['limitedPeerSegments']=[['entryCurrent','entrySupported'],['entrySupported','detachHalf','detachClosed','contact','release','settle','seated'],['hug','hugPrecontact','hugContact','seatedHug','seatedTurn','seatedGrip']]
c['acceptance']['notBlanketAccepted']=['lid65','all 35 USER currentPoseEntries','new far-hand mid-reach inserted before support','directional motion']
c['appendNote']='Only adds actual far-hand mid-reach before USER support; does not modify accepted core main nodes or old frozen contract.'
(o/'relocation.source.json').write_text(json.dumps(c,indent=2))
