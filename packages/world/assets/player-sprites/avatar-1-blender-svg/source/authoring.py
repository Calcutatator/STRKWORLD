"""Original Avatar 1 idle vectors. Run in GUI Blender through Blender MCP.

Set AVATAR_SOURCE_DIR to this directory. All coordinates are authored in the
64x64 game cell, with feet at y=56. No input bitmap is read or traced. Shapes
are painted, named Grease Pencil parts; animation is deliberately not created.
"""
import bpy
import json
import math
from pathlib import Path

ROOT = Path(AVATAR_SOURCE_DIR).resolve().parent
PALETTE = json.loads((ROOT / 'source/palette.json').read_text())
COLORS = {v['name']: v['hex'] for v in PALETTE['colors']}
VIEWS = {}


def drawing():
    shapes = []
    def p(part, color, *pts):
        shapes.append({'part': part, 'color': color, 'points': [list(p) for p in pts]})
    def r(part, color, x, y, w, h):
        p(part, color, (x,y),(x+w,y),(x+w,y+h),(x,y+h))
    return shapes,p,r


def front():
    a,p,r = drawing()
    # Scarf tails attach to the character's left (screen right in this view).
    p('scarf.tails','ink',(37,24),(46,23),(45,27),(42,29),(47,32),(43,35),(37,31))
    p('scarf.tails','teal',(38,25),(44,24),(43,27),(39,29),(43,30),(45,32),(42,33),(37,30))
    p('scarf.tails','teal_light',(39,25),(44,24),(42,26),(39,27))
    p('scarf.tails','teal_shadow',(40,29),(45,32),(42,33),(38,30))
    # Long separate trouser legs, with a small negative-space gap.
    p('leg.right','ink',(26,39),(33,39),(33,45),(31.5,51),(31,54),(26,54),(25,48))
    p('leg.right','cloth',(27,40),(32,40),(31.5,46),(30.5,52),(27,52),(26.5,47))
    p('leg.right','cloth_light',(27,41),(30,42),(29,48),(27,49))
    p('leg.right','cloth_dark',(30,42),(32,41),(31,48),(30,52),(28.5,52))
    p('leg.left','ink',(32,39),(38,39),(39,48),(39,54),(33,54),(32,46))
    p('leg.left','cloth',(33,41),(37,40),(38,48),(37.5,52),(34,52))
    p('leg.left','cloth_light',(34,42),(36,41),(36,48),(34,49))
    p('leg.left','cloth_dark',(37,41),(38,48),(37.5,52),(36,52),(36.5,46))
    # Cuffed leather boots. Bottom polygon edges are exactly y=56.
    p('boot.right','ink',(26,50),(32,50),(31,54),(31,56),(25,56),(24,55),(24,54))
    p('boot.right','leather',(27,51),(31,51),(30,54),(30,55),(25,55),(25,54))
    p('boot.right','leather_light',(27,52),(29,52),(28,54),(25,54))
    p('boot.right','cuff',(26,50),(31,50),(31,51.5),(27,52))
    r('boot.right','leather_shadow',25,54,5,1)
    p('boot.left','ink',(33,50),(39,50),(39,53),(40,54),(40,55),(39,56),(33,56))
    p('boot.left','leather',(34,51),(38,51),(38,53),(39,54),(39,55),(34,55))
    p('boot.left','leather_light',(34,52),(36,52),(36,54),(38,54),(38,55),(34,55))
    p('boot.left','cuff',(33,50),(38,50),(39,51.5),(34,52))
    # Torso and crossed harness.
    p('torso','ink',(27,25),(36,25),(39,29),(38,37),(39,41),(34,43),(32,41),(28,43),(25,41),(26,34),(25,29))
    p('torso','cloth_dark',(27,28),(36,27),(37,31),(36.5,37),(38,40),(34,41),(32,39),(28,41),(26,40))
    p('torso','teal',(28,29),(32,29),(31,38),(28,40),(27,38))
    p('torso','cloth',(33,28),(36,29),(35,38),(33,39))
    p('harness','leather_deep',(26,28),(28,27),(36,37),(37,40),(34,39))
    p('harness','leather',(27,28),(28,28),(35,37),(36,39),(34.5,38))
    p('harness','leather_deep',(36,27),(38,28),(29,40),(27,39))
    p('harness','leather',(36,28),(37,28.5),(28.5,39),(28,38))
    r('harness','leather_light',29,32,1,2)
    # Arms with warm upper light, dark underside and leather gauntlets.
    p('arm.right','ink',(25,27),(28,29),(26.5,35),(26,39),(22,40),(22,35),(23,29))
    p('arm.right','skin',(24,29),(26,29),(25.5,35),(25,37),(23,37),(23.5,33))
    p('arm.right','skin_light',(24,29),(25.5,30),(25,34),(23.5,35))
    p('arm.right','skin_shadow',(25.5,31),(26,31),(25.5,36),(24,37),(23,36),(24.5,35))
    p('hand.right','ink',(22,36),(26,36),(27,40),(26,43),(23,43),(21.5,41))
    p('hand.right','leather',(23,37),(25,37),(26,40),(25,42),(23,42),(22.5,40))
    r('hand.right','leather_light',23,38,1,3)
    p('hand.right','leather_shadow',(24,39),(26,39),(26,41),(25,42),(24,42))
    p('arm.left','ink',(37,27),(40,29),(41,35),(41,39),(37,40),(36.5,34))
    p('arm.left','skin',(38,29),(39,30),(40,35),(40,37),(38,37),(37.5,33))
    p('arm.left','skin_light',(38,29),(39,30),(39.5,34),(38,34))
    p('arm.left','skin_shadow',(39,34),(40,34),(40,37),(38,37),(38,36))
    # Small left hip pouch; the crossed harness remains the dominant leather form.
    p('satchel','ink',(38,37),(42,37),(43,40),(42,44),(38,44),(37,42))
    p('satchel','leather_shadow',(39,38),(41,38),(42,40),(41,43),(39,43),(38,41))
    p('satchel','leather',(38,38),(42,38),(42,40),(39,41),(38,40))
    r('satchel','buckle',40,39,1,1)
    p('hand.left','ink',(37,36),(41,36),(42,40),(41,43),(38,43),(37,41))
    p('hand.left','leather',(38,37),(40,37),(41,40),(40,42),(38,42))
    p('hand.left','leather_light',(38,38),(39,38),(39,41),(38,41))
    r('hand.left','leather_shadow',39,40,2,2)
    p('belt','ink',(26,37),(37,37),(38,40),(26,40))
    r('belt','leather',27,38,10,1)
    r('belt','buckle',30,37,4,3)
    r('belt','leather_deep',31,38,2,1)
    # Face: distinct eye clusters, cheek light and compact chin.
    p('face','ink',(26,15),(37,15),(39,19),(38,23),(34,26),(29,25),(26,23),(25,20))
    p('face','skin_shadow',(27,16),(37,16),(38,20),(37,23),(34,25),(29,24),(27,22),(26,20))
    p('face','skin',(28,17),(36,17),(37,20),(36,23),(33,24),(29,23),(28,21))
    p('face','skin_light',(29,18),(35,18),(36,21),(35,23),(30,23),(29,21))
    r('face','skin',26,20,2,2)
    r('face','skin',37,20,1,2)
    r('face','eye_light',28,20,3,1)
    r('face','eye_light',34,20,3,1)
    r('face','ink',29,20,1,2)
    r('face','ink',35,20,1,2)
    r('face','skin_shadow',32,22,1,1)
    p('face','skin_shadow',(32,24),(34,24),(33,24.6))
    # Sculpted hair masses, not speckled per-pixel texture.
    p('hair','ink',(23,18),(21.5,15),(24,14),(22,11),(26,11),(24,8),(29,9),(30,6),(33,9),(36,7),(36,10),(39,9),(39,12),(42,12),(41,15),(42,18),(40,18),(40,22),(38,23),(37,18),(35,18),(33,19),(33,17),(30,18),(29,19),(27,19),(26,23),(24,21),(24,18))
    p('hair','hair_shadow',(24,17),(23,15),(26,14),(24,12),(28,12),(27,10),(30,11),(31,8),(33,11),(35,9),(35,12),(38,11),(38,14),(40,13),(39,16),(40,18),(39,21),(38,18),(37,16),(35,17),(34,18),(33,16),(30,18),(29,18.5),(28,17),(26,21),(25,20),(25,17))
    p('hair','hair',(24,15),(28,13),(26,12),(30,12),(31,9),(33,12),(35,10),(35,13),(38,12),(37,15),(39,14),(39,17),(37,15),(34,15),(32,17),(30,17),(28,19),(28,16),(26,18),(26,15))
    p('hair','hair_light',(26,14),(29,13),(28,11),(31,12),(30,15),(27,17),(28,14))
    p('hair','hair_light',(32,10),(33,12),(32,15),(30,17),(30,15))
    p('hair','hair_light',(35,12),(37,12),(35,14),(34,16),(33,17),(34,14))
    p('hair','hair_light',(37,15),(39,16),(39,18),(38,17))
    p('hair','hair_glint',(27,12),(29,12.5),(28,13.5),(26,14))
    p('hair','hair_glint',(32,11),(32.5,12.5),(31,14),(31.5,12))
    p('hair','hair_deep',(25,17),(27,16),(26,21),(25,20))
    p('hair','hair_deep',(38,18),(39,19),(39,21),(38,22))
    # Wrapped scarf is in front of the neck and harness.
    p('scarf.wrap','ink',(26,23),(29,25),(34,26),(38,23),(40,25),(39,28),(35,30),(29,30),(25,28),(24,25))
    p('scarf.wrap','teal',(26,24),(29,26),(34,27),(38,24),(39,25),(38,28),(34,29),(29,29),(26,27),(25,25))
    p('scarf.wrap','teal_light',(26,24),(29,26),(34,27),(38,24),(38,26),(34,28),(29,27),(26,26))
    p('scarf.wrap','teal_shadow',(26,27),(30,28),(35,29),(34,30),(29,29))
    p('scarf.wrap','teal_glint',(27,25),(30,26),(33,26.5),(32,27),(29,26.5))
    return a


def back():
    # Legs, boots, body and arms share the same registered anatomy as front.
    a0 = front()
    kept = {'leg.right','leg.left','boot.right','boot.left','torso','arm.right','arm.left','hand.right','hand.left','belt'}
    a = [s for s in a0 if s['part'] in kept]
    def p(part,color,*pts): a.append({'part':part,'color':color,'points':[list(v) for v in pts]})
    def r(part,color,x,y,w,h): p(part,color,(x,y),(x+w,y),(x+w,y+h),(x,y+h))
    # Back harness, mirrored ownership rather than mirrored lighting.
    p('harness.back','leather_deep',(26,27),(28,26),(37,38),(35,39))
    p('harness.back','leather',(27,27),(28,27),(36,38),(35,38))
    p('harness.back','leather_deep',(36,26),(38,27),(28,39),(26,38))
    p('harness.back','leather',(36,27),(37,27),(27,38),(27,37))
    r('harness.back','buckle',31,32,2,2)
    r('belt.back','leather',27,38,10,1)
    r('belt.back','leather_shadow',30,37,4,3)
    r('belt.back','leather_light',31,38,2,1)
    # Small pouch on anatomical left, now screen left.
    p('satchel','ink',(22,37),(26,37),(27,40),(26,44),(22,44),(21,42))
    p('satchel','leather',(23,38),(25,38),(26,40),(25,43),(23,43),(22,41))
    p('satchel','leather_light',(22,38),(26,38),(26,40),(23,41),(22,40))
    r('satchel','buckle',24,39,1,1)
    # Back of scarf and two tapering tails.
    p('scarf.tails','ink',(28,25),(25,26),(20,27),(22,30),(18,32),(20,35),(23,34),(22,39),(26,37),(30,31))
    p('scarf.tails','teal',(27,27),(24,28),(22,28),(24,30),(20,32),(21,33),(25,32),(24,37),(26,35),(28,30))
    p('scarf.tails','teal_light',(25,28),(27,27),(26,30),(21,33),(20,32),(24,30))
    p('scarf.tails','teal_shadow',(27,29),(28,30),(26,35),(24,37),(25,32))
    p('scarf.wrap','ink',(25,23),(29,24),(35,24),(38,23),(40,25),(39,29),(35,31),(28,30),(24,28))
    p('scarf.wrap','teal',(26,24),(29,25),(35,25),(38,24),(39,26),(37,29),(33,30),(28,29),(25,27))
    p('scarf.wrap','teal_light',(26,25),(29,27),(34,28),(38,25),(37,27),(34,29),(29,28),(26,27))
    p('scarf.wrap','teal_shadow',(26,28),(30,29),(34,29),(37,28),(36,30),(30,30))
    # Back of hair follows the established swept, asymmetric crown.
    p('hair','ink',(23,18),(22,15),(24,14),(22,11),(26,11),(25,8),(29,9),(31,6),(32,9),(36,7),(36,10),(40,10),(39,13),(42,14),(40,16),(41,19),(39,20),(39,23),(36,25),(29,25),(25,23),(24,20))
    p('hair','hair_shadow',(24,17),(24,15),(26,14),(24,12),(28,12),(27,10),(30,11),(31,8),(33,11),(35,9),(35,12),(38,11),(37,14),(40,14),(38,16),(39,18),(38,21),(36,24),(30,24),(26,22),(26,19))
    p('hair','hair',(25,16),(28,14),(27,12),(31,12),(31,9),(33,12),(35,11),(34,14),(38,12),(36,16),(39,15),(37,18),(37,21),(35,23),(31,23),(28,21),(27,18))
    p('hair','hair_light',(25,14),(28,13),(27,11),(30,12),(30,14),(27,16))
    p('hair','hair_light',(31,10),(32,12),(31,15),(30,17),(29,20),(28,18),(29,15))
    p('hair','hair_light',(35,11),(35,13),(33,17),(32,21),(31,22),(31,19),(32,15))
    p('hair','hair_light',(38,14),(36,17),(36,20),(34,23),(34,20),(35,16))
    p('hair','hair_glint',(28,12),(30,12),(28,14),(27,14))
    p('hair','hair_glint',(32,12),(33,12),(31,15),(30,16))
    p('hair','hair_deep',(26,18),(29,22),(31,24),(29,24),(26,22))
    p('hair','hair_deep',(37,20),(38,19),(38,22),(36,24),(33,24),(36,22))
    return a


def profile(facing):
    a,p,r=drawing()
    # Base profile faces right. The two projections get different near/far
    # equipment and lighting below; anatomy is a shared construction.
    p('scarf.tails','ink',(27,25),(29,28),(26,32),(25,37),(23,42),(20,43),(19,40),(20,35),(23,30))
    p('scarf.tails','teal_shadow',(27,26),(28,28),(24,34),(24,38),(22,41),(21,41),(20.5,39),(22,34))
    p('scarf.tails','teal',(27,27),(26,30),(23,34),(22,39),(21,40),(21,37),(22,33),(25,29))
    p('scarf.tails','teal_light',(26,28),(25,31),(22,35),(23,31))
    p('leg.far','ink',(29,39),(34,39),(35,46),(34,52),(35,54),(34,56),(28,56),(27,53),(28,46))
    p('leg.far','cloth_dark',(30,40),(33,40),(34,46),(33,51),(29,52),(29,47))
    p('boot.far','leather_shadow',(29,51),(33,51),(33,53),(34,54),(33,55),(28,55),(28,53))
    p('torso','ink',(29,25),(35,25),(38,29),(37,36),(37,41),(34,43),(27,42),(27,36),(26,31))
    p('torso','cloth',(30,27),(34,27),(36,30),(35,36),(36,40),(33,42),(28,41),(29,36),(28,31))
    p('torso','cloth_dark',(28,29),(30,29),(30,36),(29,41),(28,41),(29,36))
    p('torso','teal',(33,29),(35,30),(34,36),(35,39),(33,40),(32,35))
    p('harness','leather_deep',(34,27),(36,28),(34,38),(31,41),(29,40),(33,35))
    p('harness','leather',(34,28),(35,29),(33,37),(30,40),(30,39),(32,36))
    p('leg.near','ink',(30,40),(36,40),(36,47),(34,52),(29,53),(28,50),(29,45))
    p('leg.near','cloth',(31,41),(35,41),(35,46),(33,51),(30,51),(29.5,48))
    p('leg.near','cloth_light',(31,42),(33,42),(32,47),(30,49),(30,46))
    p('leg.near','cloth_dark',(34,42),(35,42),(35,47),(33,51),(31,51),(32,48))
    p('boot.near','ink',(29,50),(34,50),(34,53),(38,54),(38,56),(28,56),(28,53))
    p('boot.near','leather',(30,51),(33,51),(33,54),(37,54),(37,55),(29,55),(29,53))
    p('boot.near','leather_light',(30,52),(32,52),(32,54),(35,54),(35,55),(29,55))
    p('boot.near','cuff',(29,50),(34,50),(33.5,52),(30,52))
    r('boot.near','leather_shadow',29,55,8,0.4)
    p('belt','ink',(28,37),(36,37),(38,38),(38,41),(35,41),(34,40),(28,40))
    r('belt','leather',29,38,7,1)
    r('belt','buckle',35,38,2,2)
    if facing == 'right':
        p('satchel','ink',(27,37),(32,37),(34,40),(33,44),(28,44),(26,41))
        p('satchel','leather_shadow',(28,38),(31,38),(33,40),(32,43),(28,43),(27,41))
        p('satchel','leather',(27,38),(32,38),(33,40),(30,41),(27,40))
        r('satchel','buckle',30,39,1,1)
    else:
        p('satchel.far','leather_shadow',(27,38),(28,38),(29,42),(28,43),(27,42))
    p('arm.near','ink',(29,27),(33,28),(34,31),(33,36),(32,39),(28,38),(27,34),(27,30))
    p('arm.near','skin',(29,29),(32,29),(33,31),(32,35),(31,37),(29,37),(28,34),(28,31))
    p('arm.near','skin_light',(29,29),(31,29),(31,32),(30,34),(28.5,34),(28.5,31))
    p('arm.near','skin_shadow',(32,31),(33,31),(32,35),(31,37),(29,37),(29,36),(31,34))
    p('hand.near','ink',(28,36),(32,36),(33,40),(32,43),(28,43),(27,40))
    p('hand.near','leather',(29,37),(31,37),(32,40),(31,42),(29,42),(28,40))
    p('hand.near','leather_light',(29,38),(30,38),(30,41),(29,41),(28.5,40))
    r('hand.near','leather_shadow',30,39,2,2)
    # Hair and profile face. Nose is a deliberate one-pixel projection.
    p('face','ink',(32,15),(38,16),(40,18),(40,20),(42,21),(41,23),(40,23),(40,25),(36,26),(31,24),(29,20))
    p('face','skin_shadow',(33,16),(38,17),(39,19),(39,21),(41,21),(40,22),(39,22),(39,24),(36,25),(32,23),(30,20))
    p('face','skin',(34,17),(38,18),(39,20),(38.5,21),(40,21),(39,22),(39,24),(36,24),(33,22))
    p('face','skin_light',(36,18),(38,18),(39,20),(38,21),(40,21),(39,22),(38,22),(38,24),(36,23))
    p('face','skin_light',(31,20),(33,19),(34,20),(33,22),(31,22))
    r('face','skin_shadow',32,20,1,1)
    r('face','eye_light',36,20,3,1)
    r('face','ink',37,20,1,2)
    r('face','skin_shadow',38,24,1,0.6)
    p('hair','ink',(24,18),(22,15),(25,14),(23,12),(27,11),(26,9),(31,9),(34,6),(34,9),(39,8),(38,11),(42,11),(40,14),(42,16),(40,18),(37,17),(36,18),(34,18),(34,22),(32,23),(31,25),(27,24),(25,22),(25,20))
    p('hair','hair_shadow',(25,18),(24,16),(27,14),(25,12),(29,12),(28,10),(32,10),(33,8),(33,11),(37,10),(36,12),(40,12),(38,15),(40,16),(38,16),(36,17),(35,18),(34,17),(33,20),(31,20),(31,23),(28,23),(26,21),(26,19))
    p('hair','hair',(25,16),(28,14),(27,13),(31,12),(30,11),(33,10),(33,12),(37,11),(35,14),(39,13),(36,16),(34,16),(32,19),(31,17),(29,20),(28,22),(27,20),(28,17))
    p('hair','hair_light',(26,14),(29,13),(29,11),(32,11),(31,13),(28,16),(26,17))
    p('hair','hair_light',(34,11),(37,10),(35,13),(32,16),(31,18),(30,17),(31,14))
    p('hair','hair_light',(37,14),(39,13),(37,16),(35,17),(35,16))
    p('hair','hair_light',(28,17),(30,15),(29,19),(28,21),(27,20))
    p('hair','hair_glint',(28,13),(30,12),(30,13),(27,15))
    p('hair','hair_glint',(33,12),(35,11),(34,13),(32,14))
    p('hair','hair_deep',(26,20),(28,22),(31,21),(30,24),(28,23),(26,22))
    p('scarf.wrap','ink',(28,23),(32,24),(35,25),(40,24),(40,28),(37,30),(32,30),(27,27))
    p('scarf.wrap','teal',(28,24),(32,25),(35,26),(39,25),(39,27),(36,29),(32,29),(28,27))
    p('scarf.wrap','teal_light',(28,24),(32,25),(35,26),(39,25),(39,26),(35,27),(32,26),(29,26))
    p('scarf.wrap','teal_shadow',(28,26),(32,28),(37,28),(36,29),(32,29),(28,27))
    if facing == 'left':
        for shape in a:
            shape['points'] = [[64-x,y] for x,y in shape['points']]
        # A second view is a distinct projection: no visible near-side bag,
        # darker scarf tail, and a shifted crown lock/near cheek highlight.
        for shape in a:
            if shape['part']=='scarf.tails' and shape['color']=='teal_light':
                shape['color']='teal'
            if shape['part']=='arm.near' and shape['color']=='skin_light':
                shape['color']='skin'
    return a


VIEWS = {'down':front(), 'left':profile('left'), 'right':profile('right'), 'up':back()}
(ROOT / 'source/idle-geometry.json').write_text(json.dumps({'cell':[64,64], 'feetPivot':[32,56], 'views':VIEWS},indent=2)+'\n')

# Materials are scene-linear; the native SVG exporter converts to sRGB.
def linear(v):
    return v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4

prefix='AV1SVG | '
old_scene=bpy.data.scenes.get(prefix+'Idle authoring')
if old_scene:
    for win in bpy.context.window_manager.windows:
        if win.scene==old_scene:
            win.scene=next(s for s in bpy.data.scenes if s!=old_scene)
    bpy.data.scenes.remove(old_scene)
for ob in list(bpy.data.objects):
    if ob.name.startswith(prefix): bpy.data.objects.remove(ob, do_unlink=True)
for mat in list(bpy.data.materials):
    if mat.name.startswith(prefix) and mat.users==0: bpy.data.materials.remove(mat)

scene=bpy.data.scenes.new(prefix+'Idle authoring')
window=bpy.context.window_manager.windows[0]
window.scene=scene
scene.render.resolution_x=64
scene.render.resolution_y=64
scene.render.resolution_percentage=100
scene.render.film_transparent=True
scene.render.fps=8
scene.frame_set(1)
scene['avatar_workflow']='D-059; first idle approval pending; no animation authored'
scene['feet_pivot']='32,56 in each 64x64 cell'
camdata=bpy.data.cameras.new(prefix+'Orthographic camera')
cam=bpy.data.objects.new(prefix+'Orthographic camera',camdata)
scene.collection.objects.link(cam)
cam.location=(0,-128,0)
cam.rotation_euler=(math.pi/2,0,0)
camdata.type='ORTHO'
camdata.ortho_scale=64
scene.camera=cam
materials=[]
for name,h in COLORS.items():
    mat=bpy.data.materials.new(prefix+name)
    bpy.data.materials.create_gpencil_data(mat)
    rgb=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    mat.grease_pencil.show_stroke=False
    mat.grease_pencil.show_fill=True
    mat.grease_pencil.fill_color=(*[linear(v) for v in rgb],1)
    materials.append(mat)
color_indexes={name:i for i,name in enumerate(COLORS)}
for direction,shapes in VIEWS.items():
    gp=bpy.data.grease_pencils.new(prefix+direction)
    gp.stroke_depth_order='2D'
    ob=bpy.data.objects.new(prefix+direction,gp)
    scene.collection.objects.link(ob)
    ob['direction']=direction
    ob['avatar']='avatar-1'
    ob['pose']='idle'
    ob['anatomical_left_equipment']='scarf tails and small hip pouch'
    for mat in materials: gp.materials.append(mat)
    last_part=None
    drawing_data=None
    for shape in shapes:
        # Preserve painter order even when a part has a second foreground pass.
        if shape['part']!=last_part:
            layer=gp.layers.new(shape['part'],set_active=True)
            layer.use_lights=False
            drawing_data=layer.frames.new(1).drawing
            last_part=shape['part']
        points=shape['points']
        drawing_data.add_strokes([len(points)])
        stroke=drawing_data.strokes[-1]
        stroke.cyclic=True
        stroke.material_index=color_indexes[shape['color']]
        stroke.fill_opacity=1
        stroke.fill_id=len(drawing_data.strokes)
        stroke.hide_stroke=True
        stroke.fill_color=(0,0,0,0)
        for point,(x,y) in zip(stroke.points,points):
            point.position=(x-32,0,32-y)
            point.radius=0.01
            point.opacity=1
        drawing_data.tag_positions_changed()
    ob.hide_set(direction!='down')
    ob.select_set(direction=='down')
    if direction=='down': bpy.context.view_layer.objects.active=ob

area=max([a for a in window.screen.areas if a.type=='VIEW_3D'],key=lambda a:a.width*a.height)
area.spaces.active.camera=cam
area.spaces.active.region_3d.view_perspective='CAMERA'
area.spaces.active.region_3d.view_camera_zoom=12
area.spaces.active.overlay.show_overlays=False
area.spaces.active.shading.type='MATERIAL'
bpy.context.view_layer.update()
print(json.dumps({'scene':scene.name, 'views':{d:len(shapes) for d,shapes in VIEWS.items()}, 'palette':len(materials)}))
