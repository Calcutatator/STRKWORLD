"""Trace contiguous colour-region boundaries of registered concept studies.

Inputs are explicitly derived from the approved concept, not a rejected draft
or the runtime sprite. Produces real polygon boundaries, not embedded bitmaps.
The original concept and sampling recipe remain in reference/ for provenance.
"""
from pathlib import Path
from collections import defaultdict, deque
import hashlib
import json
from PIL import Image

ROOT=Path(__file__).resolve().parent.parent
DIRECTIONS=('down','left','right','up')


def part_for(direction,x,y):
    # Semantic editing groups partition the visible drawing only. They do not
    # claim hidden anatomy or a rig. Reference contours remain unchanged.
    if y<19: return 'hair'
    if y<24: return 'head.face-and-fringe'
    if y<29: return 'scarf.wrap-and-tails'
    if direction in ('down','up'):
        if y>=49: return 'boot.screen-left' if x<32 else 'boot.screen-right'
        if x<28 and y<43: return 'arm.screen-left'
        if x>=37 and y<43: return 'arm.screen-right'
        if y>=39: return 'leg.screen-left' if x<32 else 'leg.screen-right'
        return 'torso.harness-and-belt'
    if (direction=='left' and x>=36) or (direction=='right' and x<28):
        if y<44: return 'scarf.tails'
    if y>=49: return 'boots'
    if y>=40: return 'legs'
    if 28<=x<=33 and y>=29: return 'arm.near'
    return 'torso.harness-and-belt'


def area(loop):
    return sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(loop,loop[1:]+loop[:1]))/2


def boundary_loops(cells):
    edges=set()
    for x,y in cells:
        if (x,y-1) not in cells: edges.add(((x,y),(x+1,y)))
        if (x+1,y) not in cells: edges.add(((x+1,y),(x+1,y+1)))
        if (x,y+1) not in cells: edges.add(((x+1,y+1),(x,y+1)))
        if (x-1,y) not in cells: edges.add(((x,y+1),(x,y)))
    outgoing=defaultdict(set)
    for a,b in edges: outgoing[a].add(b)
    loops=[]
    vectors={(1,0):0,(0,1):1,(-1,0):2,(0,-1):3}
    while edges:
        start,second=min(edges)
        prev,current=start,second
        loop=[start]
        edges.remove((prev,current)); outgoing[prev].remove(current)
        while current!=start:
            loop.append(current)
            candidates=outgoing[current]
            assert candidates,('Unclosed region',current)
            incoming=vectors[(current[0]-prev[0],current[1]-prev[1])]
            priority={1:0,0:1,3:2,2:3} # Keep each cell region on the right.
            nxt=min(candidates,key=lambda p:(priority[(vectors[(p[0]-current[0],p[1]-current[1])]-incoming)%4],p))
            edges.remove((current,nxt)); outgoing[current].remove(nxt)
            prev,current=current,nxt
        simplified=[]
        for i,b in enumerate(loop):
            a=loop[i-1]; c=loop[(i+1)%len(loop)]
            if (b[0]-a[0])*(c[1]-b[1]) != (b[1]-a[1])*(c[0]-b[0]): simplified.append(list(b))
        assert len(simplified)>=4
        loops.append(simplified)
    # One component can have multiple loops, including holes. Native Grease
    # Pencil shares their fill_id and exports one even-odd SVG compound path.
    return sorted(loops,key=lambda l:(-abs(area(l)),l))


def run():
    assert json.loads((ROOT/'review/user-decisions.json').read_text())['status']=='pending', 'Preserve approved or rejected pixels before starting another revision.'
    views={}; palette=set(); evidence={}
    for direction in DIRECTIONS:
        path=ROOT/'source/construction'/f'{direction}.png'
        im=Image.open(path).convert('RGBA'); assert im.size==(64,64)
        pixels=im.load(); masks=defaultdict(set)
        for y in range(64):
            for x in range(64):
                r,g,b,a=pixels[x,y]
                assert a in (0,255)
                if a:
                    h=f'#{r:02X}{g:02X}{b:02X}'
                    palette.add(h); masks[(part_for(direction,x,y),h)].add((x,y))
        shapes=[]; region=0
        for (part,h),mask in sorted(masks.items()):
            remaining=set(mask)
            while remaining:
                seed=min(remaining); remaining.remove(seed)
                component={seed}; queue=deque([seed])
                while queue:
                    x,y=queue.popleft()
                    for nb in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                        if nb in remaining:
                            remaining.remove(nb);component.add(nb);queue.append(nb)
                region+=1
                shapes.append({'part':part,'color':h[1:].lower(),'region':region,'pixelArea':len(component),'contours':boundary_loops(component)})
        views[direction]=shapes
        evidence[direction]={'file':str(path.relative_to(ROOT)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'regions':len(shapes),'opaquePixels':sum(s['pixelArea'] for s in shapes)}
    assert len(palette)<=24, len(palette)
    palette_data={'name':'Approved concept reconstruction','maximumColorsPerFrame':24,'colors':[{'name':h[1:].lower(),'hex':h} for h in sorted(palette)]}
    (ROOT/'source/palette.json').write_text(json.dumps(palette_data,indent=2)+'\n')
    data={'cell':[64,64],'feetPivot':[32,56],'construction':'Contiguous colour regions from approved-concept-derived studies; semantic groups are visible partitions, not a rig.','inputs':evidence,'views':views}
    (ROOT/'source/idle-geometry.json').write_text(json.dumps(data,separators=(',',':'))+'\n')
    print(json.dumps({'palette':len(palette),'views':evidence},indent=2))

if __name__=='__main__': run()
