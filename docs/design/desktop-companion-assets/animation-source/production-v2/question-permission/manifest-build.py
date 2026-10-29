from pathlib import Path
import json,hashlib
D=Path(__file__).parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
refs={str(p.relative_to(D)):sha(p) for p in (D/'references').glob('*.png') if p.name in ['upright-open-neutral-v2.png','open-screen-read-v2.png']}
manifest={'version':2,'status':'internal artwork reviewed; runtime integration pending','canvas':[512,512],'generator':'built-in image_gen','referenceSHA256':refs,'normalization':'full generated square to 512, no bbox fitting or whole-character transform','processing':'process.py: authored regional masks preserve frozen base outside actual facial/arm redraw; nod uses genuinely redrawn head/neck. No synthetic in-between warp, no whole-person opacity crossfade.','rejected':{'raw/attend.png':'wrong hand raised; replaced by attend-corrected','poses/nod.png':'superseded cold expression; use nod-soft only'},'assets':{},'sequences':{},'externalCues':{'question':'independently rendered question/response whitespace; no baked text','permission':'independently rendered lock/action card/threshold; only true allow event crosses threshold'},'eventRules':['ATTEND and UNRESOLVED never nod or resume typing on a timer','ANSWER_RECEIVED only after actual answer event','ALLOW only after explicit allow event; deny/cancel no nod and neutral withdrawal','hold head upright; never perpetual tilted neck','no pretend approval; do not auto-exit unresolved wait']}
for n in ['ask','offer','attend-corrected','offer-mid','nod-soft','listen-rest']:
 manifest['assets'][n]={'path':f'poses/{n}.png','sha256':sha(D/'poses'/f'{n}.png'),'raw':f'raw/{n}.png','rawSHA256':sha(D/'raw'/f'{n}.png'),'mask':f'masks/{n}.png','prompt':f'prompts/{n}.txt','reference':'raw/ask.png' if n=='attend-corrected' else 'raw/offer.png' if n=='offer-mid' else 'raw/nod.png' if n=='nod-soft' else 'references/upright-open-neutral-v2.png'}
def step(p,ms,phase):return {'pose':p,'durationMs':ms,'phase':phase}
read='references/open-screen-read-v2.png';neutral='references/upright-open-neutral-v2.png'
manifest['sequences']={
'questionEnter':[step(read,160,'READ'),step(neutral,200,'ADDRESS'),step('attend-corrected',120,'LIFT'),step('ask',520,'ASK'),step('attend-corrected',160,'LOWER'),step('listen-rest',None,'ATTEND')],
'questionAnswered':[step('listen-rest',140,'RECEIVED'),step(neutral,120,'LOWER'),step('nod-soft',160,'ANSWER_RECEIVED'),step(neutral,120,'RECOVER'),step(read,180,'RETURN')],
'questionCancel':[step('listen-rest',120,'RETRACT'),step(neutral,180,'NEUTRAL'),step(read,180,'RETURN')],
'permissionEnter':[step(read,120,'ACTIVE'),step('attend-corrected',240,'STOP'),step('offer-mid',130,'OFFER_START'),step('offer',650,'OFFER'),step('offer-mid',180,'LOWER_PALM'),step('attend-corrected',150,'RETRACT'),step('listen-rest',None,'UNRESOLVED')],
'permissionAllow':[step('listen-rest',140,'ALLOW_EVENT'),step(neutral,120,'HANDS_RETURN'),step('nod-soft',160,'ALLOW_RECEIVED'),step(neutral,120,'RECOVER'),step(read,160,'RETURN')],
'permissionDenyOrCancel':[step('listen-rest',180,'RETRACT_NEUTRAL'),step(neutral,220,'NEUTRAL'),step(read,160,'RETURN')]}
(D/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2,sort_keys=True))
# Exact source references for edit-chain reproducibility.
(D/'reference-sha.json').write_text(json.dumps({'anchors':refs,'raw':{p.name:sha(p) for p in (D/'raw').glob('*.png')}},indent=2,sort_keys=True))
