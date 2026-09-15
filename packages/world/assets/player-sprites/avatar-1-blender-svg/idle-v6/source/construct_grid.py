"""Image-assisted, explicit editable pixel construction; no raster embedded in SVG."""
from pathlib import Path
from PIL import Image
import json, hashlib
import numpy as np
ROOT=Path(__file__).resolve().parent.parent
SPECS={'down':{'file':'front-pixel-v1.png','pivotX':618,'top':254,'bottom':1067,'cropX':[0,1254]},
'left':{'file':'turnaround-pixel-v1.png','pivotX':344,'top':176,'bottom':796,'cropX':[0,590]},
'right':{'file':'turnaround-pixel-v1.png','pivotX':1431,'top':176,'bottom':796,'cropX':[1180,1774]},
'up':{'file':'turnaround-pixel-v1.png','pivotX':892,'top':176,'bottom':796,'cropX':[590,1180]}}
# Shared, deliberately economical material ramps. All channels <=254 for native SVG parity.
RAMPS={
'ink':['#201b1d','#332324'],
'hair':['#4b2919','#754020','#a75b27','#ce8238','#edaa58'],
'skin':['#a96539','#d28b4b','#efb870','#fed393'],
'scarf':['#0b3b49','#105664','#17788a','#2995a2','#56b4b9'],
'petrol':['#17313a','#204653','#2e5d69'],
'charcoal':['#29282d','#3e3d44','#575458','#716966'],
'leather':['#422c24','#61422c','#886035','#b2844e','#d4a96c'],
'gold':['#9a713b','#ebc77e'],
'eye':['#f5e0b3','#30221b']}
PALETTE=[{'name':f'{name}.{i}','hex':h} for name,ramp in RAMPS.items() for i,h in enumerate(ramp)]
RGB=np.array([[int(c['hex'][i:i+2],16) for i in (1,3,5)] for c in PALETTE])
def run():
 assert json.loads((ROOT/'review/user-decisions.json').read_text())['status']=='internal-refinement', 'Frozen review: create a new revision or explicitly reopen refinement'
 views={}; refs=[]
 for d,s in SPECS.items():
  p=ROOT/'studies'/s['file']; im=np.array(Image.open(p).convert('RGBA')); scale=50/(s['bottom']-s['top']); rows=[[-1]*64 for _ in range(64)]
  for y in range(6,56):
   for x in range(64):
    sx=round(s['pivotX']+(x+.5-32)/scale); sy=round(s['top']+(y+.5-6)/scale)
    if not(s['cropX'][0]<=sx<s['cropX'][1] and 0<=sy<im.shape[0]):continue
    rgba=im[sy,sx]
    if rgba[3]<128:continue
    rows[y][x]=int(np.argmin(((RGB-rgba[:3])**2).sum(axis=1)))
  views[d]={'rows':rows,'registration':{**s,'scale':scale},'edits':[]}
  ref={'file':'studies/'+s['file'],'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  if ref not in refs:refs.append(ref)
 grid={'schemaVersion':1,'cell':[64,64],'feetPivot':[32,56],'palette':PALETTE,'views':views,'provenance':{'method':'Internal ImageGen pixel construction studies registered to the native grid, with explicit palette and recorded artist edits; contiguous regions become native Blender SVG source.','conceptSha256':'8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92','styleSha256':'f1de96b3038042aaca726c18ae87fe374e8dac2bbda7d0a2359d53f44ad08ed4','constructionReferences':refs,'approval':'Internal construction only; not user-approved idles'}}
 (ROOT/'source/artist-grid.json').write_text(json.dumps(grid,indent=2)+'\n')
 for d,v in views.items():
  data=np.zeros((64,64,4),dtype=np.uint8)
  for y,row in enumerate(v['rows']):
   for x,k in enumerate(row):
    if k>=0:data[y,x]=[*RGB[k],255]
  im=Image.fromarray(data); im.save(ROOT/f'studies/{d}-grid.png');im.resize((512,512),Image.Resampling.NEAREST).save(ROOT/f'studies/{d}-grid-8x.png')
 print(len(PALETTE),list(views))
if __name__=='__main__':run()
