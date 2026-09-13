"""Reconstruct high-detail ImageGen studies as smooth editable vector regions.

Run with the dedicated vtracer/svgpathtools/Pillow environment. No pixel grid:
registered construction raster is 1024 square; Bezier source is retained and
sampled to <=0.10 source-canvas pixel deviation for native Grease Pencil.
"""
from pathlib import Path
import hashlib, json, re, xml.etree.ElementTree as ET
import numpy as np
from PIL import Image
from svgpathtools import parse_path, Line
import vtracer
ROOT=Path(__file__).resolve().parent.parent
SOURCE=ROOT/'source'
OUT=SOURCE/'vectors'; OUT.mkdir(exist_ok=True)
SPECS={
 'down':('front-illustrated-v1.png',(0,0,1254,1254),600,7,1218),
 'left':('illustrated-turnaround-v1.png',(0,0,525,1086),235,15,1058),
 'right':('illustrated-turnaround-v1.png',(525,0,900,1086),725,15,1058),
 'up':('illustrated-turnaround-v1.png',(900,0,1448,1086),1240,15,1053),
}
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
images={}
for direction,(file,box,cx,top,bottom) in SPECS.items():
 im=Image.open(ROOT/'studies'/file).convert('RGBA').crop(box)
 rgb=np.array(im); mask=np.min(rgb[:,:,:3],axis=2)<228
 rgb[:,:,3]=np.where(mask,255,0); rgb[~mask,:3]=255
 im=Image.fromarray(rgb)
 scale=832/(bottom-top)
 # PIL inverse affine mapping, preserving native details on a 1024 working canvas.
 xoff=512-(cx-box[0])*scale; yoff=896-bottom*scale
 reg=im.transform((1024,1024),Image.Transform.AFFINE,(1/scale,0,-xoff/scale,0,1/scale,-yoff/scale),resample=Image.Resampling.BICUBIC)
 images[direction]=reg
# Shared palette preserves kit/skin color consistency across orientations.
strip=Image.new('RGB',(4096,1024),'white')
for n,(direction,im) in enumerate(images.items()): strip.paste(im,(n*1024,0),im)
pal=strip.quantize(colors=160,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE)
shared=np.array(pal.getpalette(),dtype=float).reshape(-1,3)[:160]
shared=np.minimum(shared,254)
colors={}; views={}; stats={}
for direction,im in images.items():
 white=Image.new('RGB',im.size,'white'); white.paste(im,mask=im.getchannel('A'))
 q=white.quantize(palette=pal,dither=Image.Dither.NONE).convert('RGBA')
 q.putalpha(im.getchannel('A').point(lambda a:255 if a>=128 else 0))
 registered=OUT/f'{direction}-registered.png'; q.save(registered)
 svg=OUT/f'{direction}-bezier.svg'
 vtracer.convert_image_to_svg_py(str(registered),str(svg),colormode='color',hierarchical='stacked',mode='spline',filter_speckle=5,color_precision=8,layer_difference=12,corner_threshold=65,length_threshold=3.5,max_iterations=10,splice_threshold=45,path_precision=3)
 shapes=[]
 for i,el in enumerate(ET.parse(svg).getroot().iter()):
  if el.tag.split('}')[-1]!='path': continue
  fill=el.get('fill'); assert re.fullmatch(r'#[0-9A-Fa-f]{6}',fill),fill
  rgb=tuple(min(254,int(fill[j:j+2],16)) for j in (1,3,5))
  if min(rgb)>228: continue
  rgb=tuple(int(v) for v in shared[np.argmin(np.sum((shared-np.array(rgb))**2,axis=1))])
  color='#'+''.join(f'{v:02X}' for v in rgb)
  name=colors.setdefault(color,'fill-'+str(len(colors)).zfill(3))
  transform=el.get('transform','translate(0,0)')
  nums=[float(n) for n in re.findall(r'-?\d+(?:\.\d+)?',transform)]
  assert transform.startswith('translate(') and len(nums)==2,transform
  ox,oy=nums
  def xy(z): return [round((z.real+ox)/2,4),round((z.imag+oy)/2,4)]
  loops=[]
  for sub in parse_path(el.get('d')).continuous_subpaths():
   if not len(sub): continue
   pts=[sub[0].start]
   def subdiv(seg,a,b,depth=0):
    p0,p1=seg.point(a),seg.point(b)
    errs=[abs(seg.point(a+(b-a)*t)-(p0+(p1-p0)*t)) for t in (.25,.5,.75)]
    if max(errs)<=.20 or depth>=14:
     pts.append(p1)
    else:
     m=(a+b)/2; subdiv(seg,a,m,depth+1); subdiv(seg,m,b,depth+1)
   for segment in sub: subdiv(segment,0,1)
   if abs(pts[-1]-pts[0])<1e-6: pts.pop()
   if len(pts)>=3: loops.append([xy(p) for p in pts])
  if loops: shapes.append({'part':f'illustration-region-{i:04d}','color':name,'contours':loops})
 views[direction]=shapes
 stats[direction]={'regions':len(shapes),'points':sum(len(c) for s in shapes for c in s['contours'])}
refs=['studies/front-illustrated-v1.png','studies/illustrated-turnaround-v1.png']
inputs=[str(p.relative_to(ROOT)) for p in sorted(OUT.glob('*-bezier.svg'))]
geometry={'cell':[512,512],'feetPivot':[256,448],'logicalCell':[64,64],
 'conceptSha256':sha(ROOT.parent/'concept/avatar-1-concept-v2.png'),
 'constructionReferences':refs,'provenance':{
 'method':'ImageGen construction studies registered at 1024px; shared detailed color palette; VTracer 0.6.15 spline reconstruction; adaptive Bezier sampling at 0.10 source-pixel tolerance. No 64px pixel-grid input.',
 'constructionReferences':[{'file':p,'sha256':sha(ROOT/p)} for p in refs],
 'inputFiles':[{'file':p,'sha256':sha(ROOT/p)} for p in inputs]},'views':views}
assert len(colors)<=256,len(colors)
(SOURCE/'idle-geometry.json').write_text(json.dumps(geometry,separators=(',',':'))+'\n')
(SOURCE/'palette.json').write_text(json.dumps({'maximumColorsPerFrame':256,'colors':[{'name':n,'hex':c} for c,n in colors.items()]},indent=2)+'\n')
(OUT/'construction-record.json').write_text(json.dumps({'canvas':1024,'sourceCanvas':512,'paletteColors':len(colors),'views':stats,'registration':SPECS},indent=2)+'\n')
print(json.dumps({'paletteColors':len(colors),'views':stats}))
