"""Freeze the selected, reviewed concept sampling for vector reconstruction."""
from pathlib import Path
import hashlib
import json
import shutil
root=Path(__file__).resolve().parent.parent
assert json.loads((root/'review/user-decisions.json').read_text())['status']=='pending', 'Preserve an approved/rejected revision before changing its source.'
study=json.loads((root/'reference/studies/study.json').read_text())
(root/'source/construction').mkdir(parents=True,exist_ok=True)
files={}
for d in ('down','left','right','up'):
    source=root/f'reference/studies/{d}-construction-64.png'
    dest=root/f'source/construction/{d}.png'
    shutil.copyfile(source,dest)
    files[d]={'selectedStudy':str(source.relative_to(root)),'construction':str(dest.relative_to(root)),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()}
manifest={'sourceConcept':study['sourceSha256'],'studyScript':study['scriptSha256'],'studyReportSha256':hashlib.sha256((root/'reference/studies/study.json').read_bytes()).hexdigest(),'files':files,'purpose':'Construction template derived from the approved concept; later Blender SVG/PNG output must match these pixels. This does not establish user approval.'}
(root/'source/construction/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Froze four selected concept studies with provenance.')
