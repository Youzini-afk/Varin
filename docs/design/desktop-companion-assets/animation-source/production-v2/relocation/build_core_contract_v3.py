from pathlib import Path
import json,hashlib
r=Path(__file__).parent
spec={
 'closedSeated':('../lid/frames/closed-rest-rigid-v2.png',True),
 'midSeated':('frames/lap-release-mid-v1.png',True),
 'secureSeated':('frames/seated-secure-v2.png',True),
 'contactSeated':('frames/land-contact-v1.png',True),
 'closedDetached':('frames/closed-rest-no-stool-v4.png',False),
 'midDetached':('frames/lap-release-mid-no-stool-v4.png',False),
 'secureDetached':('frames/secure-no-stool-v4.png',False),
 'contactDetached':('frames/contact-no-stool-v3.png',False),
 'airborneNeutral':('frames/detach-first-v2.png',False),
 'airborneResponse':('frames/airborne-response-v3.png',False)}
pairs={'closedSeated':'closedDetached','midSeated':'midDetached','secureSeated':'secureDetached','contactSeated':'contactDetached'}
release={
 'closedDetached':[('closedSeated',100)],
 'midDetached':[('midSeated',100),('closedSeated',110)],
 'secureDetached':[('secureSeated',100),('midSeated',110),('closedSeated',110)],
 'contactDetached':[('contactSeated',100),('secureSeated',110),('midSeated',110),('closedSeated',110)],
 'airborneNeutral':[('contactDetached',90),('contactSeated',100),('secureSeated',110),('midSeated',110),('closedSeated',110)],
 'airborneResponse':[('airborneNeutral',90),('contactDetached',90),('contactSeated',100),('secureSeated',110),('midSeated',110),('closedSeated',110)]}
grab={
 'closedDetached':[('midDetached',80),('secureDetached',90),('contactDetached',90),('airborneNeutral',140)],
 'midDetached':[('secureDetached',90),('contactDetached',90),('airborneNeutral',140)],
 'secureDetached':[('contactDetached',90),('airborneNeutral',140)],
 'contactDetached':[('airborneNeutral',140)],
 'airborneNeutral':[],
 'airborneResponse':[('airborneNeutral',120)]}
nodes={}
for name,(path,embedded) in spec.items():
 node={'source':path,'sourceSHA256':hashlib.sha256((r/path).read_bytes()).hexdigest(),'embeddedStool':embedded,'handsSupported':True,'stage':'parent core visual direction accepted; no-stool derivatives pending focused peer' if not embedded else 'parent accepted for integration; native not yet verified'}
 detached=pairs.get(name,name);node['grabImmediate']=detached;node['grabNext']=[{'node':n,'durationMs':t} for n,t in grab[detached]];node['releaseNext']=[{'node':n,'durationMs':t} for n,t in (release[detached] if not embedded else [])]
 if not embedded:
  seated=next((k for k,v in pairs.items() if v==name),None)
  if seated:node['originalSeatedSource']=spec[seated][0];node['originalSeatedSHA256']=hashlib.sha256((r/spec[seated][0]).read_bytes()).hexdigest()
 nodes[name]=node
entries=[{'sourceSHA256':nodes[k]['sourceSHA256'],'currentNode':k,'detachedNode':v,'immediate':True} for k,v in pairs.items()]
world='frames/world-stool-grounded-v4.png'
j={'schemaVersion':1,'geometryReference':'varin-upright-v2','stage':'new core interaction contract for integration review; not universal family coverage','canvas':[512,512],'closedEndpoint':'closedSeated','nodes':nodes,'entries':entries,'worldStool':{'source':world,'sourceSHA256':hashlib.sha256((r/world).read_bytes()).hexdigest(),'freezeAtDragOrigin':True,'fadeOutMs':100,'landingFadeInMs':100,'contactAnchorApprox':[280,349],'ownership':'never render world stool together with embeddedStool=true; atomically hide world layer at embedded counterpart takeover'},'interactionRules':['At drag threshold, synchronously display grabImmediate from actual sourceSHA before moving root; never wait for the artistic recovery chain.','During any recovery or landing exposure, regrab uses that actual node grabImmediate, not the original entry.','Releasing a same-leg detached node restores its exact originalSeatedSource after chair fade-in; no forced leg curling or route through airborne response.','Release from airborne uses current supported pose and explicit contact chain.','No-stool frames remain body-only while pointer root moves; the world stool stays at the captured origin.','All open-laptop and six-family current-pose entries remain missing until explicitly authored/mapped; do not alias these closed-only entries by family name.'],'airborneOptionalResponse':[{'node':'airborneResponse','durationMs':150},{'node':'airborneNeutral','durationMs':180}]}
(r/'core-transition-contract-v3.json').write_text(json.dumps(j,indent=2)+'\n')
