from pathlib import Path
import json,hashlib
r=Path(__file__).resolve().parent;root=r.parent.parent;frames=root/'editing-dispatch/frames'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
# Only existing authored exposures; recovery never re-emits dispatch/select business cues.
routes={
'screen-read':[],
'neutral':[('screen-read',140)],
'gaze-right':[('neutral',130),('screen-read',140)],
'split-gaze':[('review-v2',120),('screen-read',170)],
'review-v2':[('screen-read',170)],
'type-burst':[('screen-read',170)],
'type-prepare':[('type-burst',150),('screen-read',170)],
'type-forward':[('type-prepare',180),('type-burst',150),('screen-read',170)],
'type-forward-hands-b':[('type-forward',110),('type-prepare',180),('type-burst',150),('screen-read',170)],
'review':[('review-rise',180),('select',170),('type-burst',150),('screen-read',170)],
'review-rise':[('select',170),('type-burst',150),('screen-read',170)],
'select':[('type-burst',150),('screen-read',170)],
'dispatch-a-gaze':[('dispatch-rise-gaze',170),('dispatch-transit-gazeB',180),('review-v2',180),('screen-read',170)],
'dispatch-rise-gaze':[('dispatch-transit-gazeB',180),('review-v2',180),('screen-read',170)],
'dispatch-transit-gazeB':[('review-v2',180),('screen-read',170)],
'dispatch-b-v2-gazeB':[('dispatch-transit-gazeB',170),('review-v2',180),('screen-read',170)],
'dispatch-a':[('dispatch-rise',170),('dispatch-transit',180),('review-v2',180),('screen-read',170)],
'dispatch-rise':[('dispatch-transit',180),('review-v2',180),('screen-read',170)],
'dispatch-transit':[('review-v2',180),('screen-read',170)],
'dispatch-b-v2':[('dispatch-transit',170),('review-v2',180),('screen-read',170)]}
rows=[]
for name,route in routes.items():
 p=frames/f'{name}.png';rows.append({'fromSourceSHA256':sha(p),'fromPose':name,'fromFrame':str(p.relative_to(root)),'recovery':[{'frame':str((frames/f'{n}.png').relative_to(root)),'sourceSHA256':sha(frames/f'{n}.png'),'holdMs':ms,'cue':'recovery-only','suppressAllSceneActionCues':True} for n,ms in route],'toPose':'open-screen','toAnchorSHA256':sha(frames/'screen-read.png'),'alreadyAtTarget':not route})
manifest=json.loads((root/'editing-dispatch/sequence-manifest.json').read_text());used={f['sourceSHA256'] for seq in manifest['sequences'].values() for f in seq['frames']};covered={x['fromSourceSHA256'] for x in rows};assert used<=covered
(r/'recovery-by-source-sha.json').write_text(json.dumps({'schemaVersion':1,'geometryReference':'varin-upright-v2','status':'existing-art recovery support candidate; runtime continuity still needs rendered QA','targetPublicPose':'open-screen','sourceSequences':'editing-dispatch/sequence-manifest.json','actualSequenceSHAcoverage':{'used':len(used),'covered':len(used&covered),'complete':used<=covered},'rules':['Every recovery step uses existing authored drawing only.','Never replay original DISPATCH, SELECT, REVISE, or other one-shot scene cue during recovery.','Typing exits forward posture once; no alternating body bob.','REVIEW lowers its raised image-left hand through review-rise and select hand-contact drawing; select is recovery-only, not a new selection event.','For carried mode resolve each original SHA to its no-stool derived SHA and preserve carrier geometry; do not restore seated pixels.'],'routes':rows},indent=2)+'\n')
print('covered',len(used),'actual source SHAs')
