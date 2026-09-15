"""Deliberate grid edits after inspecting the sampled construction at native scale."""
from pathlib import Path
from PIL import Image
import json
ROOT=Path(__file__).resolve().parent.parent
assert json.loads((ROOT/'review/user-decisions.json').read_text())['status']=='internal-refinement', 'Frozen review: source edits invalidate review'
p=ROOT/'source/artist-grid.json';g=json.loads(p.read_text())
# Face uses two stable eye clusters instead of accidental illustration samples.
PATCHES={'down':[
 (19,27,'0990AA90A0'),(20,27,'0990AA90A0'),(21,28,'099AAA90'),(22,29,'099990'),(23,30,'0770'),
 # Separate the neck from the scarf with a restrained bright lip and dark fold.
 (24,28,'DDEECEDDD'),
]}
for d,patches in PATCHES.items():
 if d not in g['views']:continue
 rows=g['views'][d]['rows'];edits=[]
 for y,x,values in patches:
  for dx,c in enumerate(values):
   k=int(c,32) if c!='.' else -1;prev=rows[y][x+dx];rows[y][x+dx]=k
   edits.append({'x':x+dx,'y':y,'before':prev,'after':k})
 g['views'][d]['edits']=edits
p.write_text(json.dumps(g,indent=2)+'\n')
for d,v in g['views'].items():
 im=Image.new('RGBA',(64,64))
 for y,row in enumerate(v['rows']):
  for x,k in enumerate(row):
   if k>=0:im.putpixel((x,y),tuple(bytes.fromhex(g['palette'][k]['hex'][1:]))+(255,))
 im.save(ROOT/f'studies/{d}-grid.png')
 paper=Image.new('RGBA',(64,64),'#e5ddd0');paper.alpha_composite(im);paper.resize((512,512),Image.Resampling.NEAREST).save(ROOT/f'studies/{d}-light-8x.png')
