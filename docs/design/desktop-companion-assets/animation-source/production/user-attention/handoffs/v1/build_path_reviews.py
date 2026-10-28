from pathlib import Path
import json,shutil,subprocess
r=Path(__file__).resolve().parent
tool=next(parent/'tools/desktop-companion-animation' for parent in r.parents if (parent/'tools/desktop-companion-animation/pack_sequence.py').is_file())
for name,parts in [('permission-denied-path',['permission-ask-enter-v1','permission-unresolved-hold-v1','relaxed-to-neutral-v1']),('question-answered-path',['question-ask-enter-v1','question-unanswered-hold-v1','relaxed-to-neutral-v1','answer-understood-v1'])]:
 o=r/name;o.mkdir(exist_ok=True);frames=[]
 for part in parts:
  d=json.loads((r/part/'sequence.source.json').read_text())
  for f in d['frames']:
   i=len(frames);dest=f'frame-{i:03}.png';shutil.copyfile(r/part/f['source'],o/dest);frames.append({**f,'source':dest,'phase':part})
 d.update(id=name,loop=None,frames=frames,entryPose='seated-open-neutral-keyboard',exitPose='seated-open-neutral-keyboard',warning='Finite handoff choreography review only. This scripted demo injects an explicit simulated decision AFTER one hold cycle; production MUST NOT resolve permission/question on elapsed time.')
 (o/'sequence.source.json').write_text(json.dumps(d,indent=2));subprocess.run(['python',str(tool/'pack_sequence.py'),str(o/'sequence.source.json'),str(o/'export')],check=True,capture_output=True);subprocess.run(['python',str(tool/'make_review.py'),str(o/'export/sequence.json'),str(o/'review.html'),'--stage','motion-candidate'],check=True,capture_output=True)
 print(name,len(frames),sum(f['durationMs']for f in frames))
