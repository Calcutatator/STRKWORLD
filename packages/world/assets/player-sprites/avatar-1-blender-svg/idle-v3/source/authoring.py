"""Author the approved-concept idle draft as native Grease Pencil fills via MCP."""
import bpy
import hashlib
import json
import math
from pathlib import Path

ROOT=Path(AVATAR_SOURCE_DIR).resolve().parent
concept=ROOT.parent/'concept'
approval=json.loads((concept/'approval.json').read_text())
assert approval['status']=='approved'
assert hashlib.sha256((concept/approval['artifact']).read_bytes()).hexdigest()==approval['sha256']
assert json.loads((ROOT/'review/user-decisions.json').read_text())['status']=='pending'
geometry=json.loads((ROOT/'source/idle-geometry.json').read_text())
assert geometry['conceptSha256']==approval['sha256']
palette=json.loads((ROOT/'source/palette.json').read_text())
prefix='AV1V3 | '
window=bpy.context.window_manager.windows[0]
old_scene=bpy.data.scenes.get(prefix+'Idle authoring')
if old_scene:
    for win in bpy.context.window_manager.windows:
        if win.scene==old_scene:
            win.scene=next((s for s in bpy.data.scenes if s!=old_scene),None) or bpy.data.scenes.new('Art workspace')
    bpy.data.scenes.remove(old_scene)
for ob in list(bpy.data.objects):
    if ob.name.startswith(prefix): bpy.data.objects.remove(ob,do_unlink=True)
for data in list(bpy.data.grease_pencils):
    if data.name.startswith(prefix) and data.users==0: bpy.data.grease_pencils.remove(data)
for mat in list(bpy.data.materials):
    if mat.name.startswith(prefix) and mat.users==0: bpy.data.materials.remove(mat)
scene=bpy.data.scenes.new(prefix+'Idle authoring'); window.scene=scene
scene.render.resolution_x=64;scene.render.resolution_y=64;scene.render.resolution_percentage=100
scene.render.pixel_aspect_x=1;scene.render.pixel_aspect_y=1
scene.render.film_transparent=True;scene.render.fps=8;scene.frame_set(1)
scene['concept_sha256']=approval['sha256'];scene['concept_approval']='James: Yes good concept move forward'
scene['sprite_approval']='Pending';scene['rig_status']='Layered visible vector artwork; animation not yet authorized'
camdata=bpy.data.cameras.new(prefix+'Orthographic camera');cam=bpy.data.objects.new(prefix+'Orthographic camera',camdata)
scene.collection.objects.link(cam);cam.location=(0,-128,0);cam.rotation_euler=(math.pi/2,0,0)
camdata.type='ORTHO';camdata.ortho_scale=64;scene.camera=cam
# Pack the exact approved concept beside the editable artwork as an in-scene reference.
refimage=bpy.data.images.load(str(concept/approval['artifact']),check_existing=True);refimage.pack()
ref=bpy.data.objects.new(prefix+'Approved concept reference',None);ref.empty_display_type='IMAGE';ref.data=refimage
ref.empty_display_size=96;ref.location=(100,1,0);ref.rotation_euler=(math.pi/2,0,0);ref.hide_render=True
ref['sha256']=approval['sha256'];scene.collection.objects.link(ref)
def linear(v):return v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4
materials=[];indexes={}
for i,entry in enumerate(palette['colors']):
    mat=bpy.data.materials.new(prefix+entry['name']);bpy.data.materials.create_gpencil_data(mat)
    rgb=[min(255,int(entry['hex'][j:j+2],16)+0.25)/255 for j in (1,3,5)]
    mat.grease_pencil.show_stroke=False;mat.grease_pencil.show_fill=True
    mat.grease_pencil.fill_color=(*[linear(v) for v in rgb],1)
    indexes[entry['name']]=i;materials.append(mat)
for direction,shapes in geometry['views'].items():
    gp=bpy.data.grease_pencils.new(prefix+direction);gp.stroke_depth_order='2D'
    ob=bpy.data.objects.new(prefix+direction,gp);scene.collection.objects.link(ob)
    ob['direction']=direction;ob['pose']='idle';ob['concept_sha256']=approval['sha256']
    for mat in materials:gp.materials.append(mat)
    for index,shape in enumerate(shapes):
        layer=gp.layers.new(f"{index:03d}_{shape['part']}",set_active=True);layer.use_lights=False
        drawing=layer.frames.new(1).drawing
        for contour in shape['contours']:
            drawing.add_strokes([len(contour)]);stroke=drawing.strokes[-1];stroke.cyclic=True
            stroke.material_index=indexes[shape['color']];stroke.fill_opacity=1;stroke.fill_color=(0,0,0,0)
            stroke.fill_id=1;stroke.hide_stroke=True
            for point,(x,y) in zip(stroke.points,contour):
                point.position=(x-32,0,32-y);point.radius=0.01;point.opacity=1
        drawing.tag_positions_changed()
    ob.hide_set(direction!='down');ob.select_set(direction=='down')
    if direction=='down':bpy.context.view_layer.objects.active=ob
area=max([a for a in window.screen.areas if a.type=='VIEW_3D'],key=lambda a:a.width*a.height)
area.spaces.active.camera=cam;area.spaces.active.region_3d.view_perspective='CAMERA'
area.spaces.active.region_3d.view_camera_zoom=0;area.spaces.active.overlay.show_overlays=False
area.spaces.active.shading.type='MATERIAL';bpy.context.view_layer.update()
print(json.dumps({'scene':scene.name,'shapes':{d:len(s) for d,s in geometry['views'].items()},'conceptSha256':approval['sha256']}))
