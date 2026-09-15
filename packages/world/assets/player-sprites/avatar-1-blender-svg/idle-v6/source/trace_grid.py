"""Convert explicit editable colour grids into actual contiguous vector boundaries.
The new study, registration and deliberate grid edits are provenance inputs;
Blender GP and its native SVG exports are the editable master and pose outputs.
No images are embedded into SVG. Visible partitions do not claim an animation rig.
"""
from pathlib import Path
from collections import defaultdict, deque
import hashlib, json
ROOT=Path(__file__).resolve().parent.parent

def part_for(d,x,y,k,palette):
    name=palette[k]['name']
    skin=name.startswith('skin')
    teal=name.startswith('scarf')
    if y<24:
        if skin or (name.startswith('ink') and y>=18): return 'head.face'
        return 'head.hair'
    if teal and (y<24 or ((x>36 if d in ('down','left') else x<28) and y<40)):
        return 'scarf.wrap' if 27<=x<=37 and y<25 else 'scarf.tails.wearer-left'
    if y>=48: return 'boot.screen-left' if x<32 else 'boot.screen-right'
    if y>=42: return 'leg.screen-left' if x<32 else 'leg.screen-right'
    if (d=='down' and 23<=x<=28 and 28<=y<=35) or (d=='right' and 26<=x<=31 and 28<=y<=35) or (d=='up' and 35<=x<=41 and 27<=y<=35): return 'pouch.wearer-right'
    if skin or x<27 or x>37: return 'arm.screen-left' if x<32 else 'arm.screen-right'
    if y>=30: return 'tunic.hem-and-belt'
    return 'torso.tunic-and-harness'

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
    gridpath=ROOT/'source/artist-grid.json'; grid=json.loads(gridpath.read_text())
    approval=json.loads((ROOT.parent/'concept/approval.json').read_text())
    assert approval['status']=='approved'
    assert json.loads((ROOT/'review/user-decisions.json').read_text())['status']=='internal-refinement'
    assert grid['provenance']['conceptSha256']==approval['sha256']
    palette=grid['palette']; assert len(palette)<=32
    views={}
    for d,v in grid['views'].items():
        assert len(v['rows'])==64 and all(len(r)==64 for r in v['rows'])
        masks=defaultdict(set)
        for y,row in enumerate(v['rows']):
            for x,k in enumerate(row):
                assert type(k)==int and -1<=k<len(palette)
                if k>=0: masks[(part_for(d,x,y,k,palette),k)].add((x,y))
        shapes=[]
        for (part,k),mask in sorted(masks.items()):
            remaining=set(mask)
            while remaining:
                seed=min(remaining); remaining.remove(seed); component={seed}; queue=deque([seed])
                while queue:
                    x,y=queue.popleft()
                    for n in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                        if n in remaining: remaining.remove(n); component.add(n); queue.append(n)
                shapes.append({'part':part,'color':palette[k]['name'],'pixelArea':len(component),'contours':boundary_loops(component)})
        views[d]=shapes
    geometry={'cell':[64,64],'feetPivot':[32,56],'conceptSha256':approval['sha256'],'styleSha256':grid['provenance']['styleSha256'],
        'constructionReferences':[r['file'] for r in grid['provenance']['constructionReferences']],
        'provenance':{**grid['provenance'],'artistGridSha256':hashlib.sha256(gridpath.read_bytes()).hexdigest(),'semanticGroups':'Visible editing partitions only; no hidden anatomy or rig yet'},'views':views}
    (ROOT/'source/idle-geometry.json').write_text(json.dumps(geometry,separators=(',',':'))+'\n')
    (ROOT/'source/palette.json').write_text(json.dumps({'name':'Teal runner - bright shared production palette','maximumColorsGlobal':32,'colors':palette},indent=2)+'\n')
    print(json.dumps({d:{'regions':len(v),'pixels':sum(s['pixelArea'] for s in v)} for d,v in views.items()}))
if __name__=='__main__': run()
