"""Export existing Avatar 1 Grease Pencil poses, without rebuilding the art.

Run via Blender MCP; supply AVATAR_SOURCE_DIR. The native exporter projects
from the largest VIEW_3D, so configure that view and the orthographic camera.
"""
import bpy
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

root=Path(AVATAR_SOURCE_DIR).resolve().parent
prefix='AV1SVG | '
scene=bpy.data.scenes[prefix+'Idle authoring']
window=bpy.context.window_manager.windows[0]
window.scene=scene
area=max([a for a in window.screen.areas if a.type=='VIEW_3D'],key=lambda a:a.width*a.height)
region=next(r for r in area.regions if r.type=='WINDOW')
cam=scene.camera
cam.location=(0,-128,0)
cam.rotation_euler=(math.pi/2,0,0)
cam.data.ortho_scale=64
cam.data.shift_x=0
cam.data.shift_y=0
scene.render.resolution_x=64
scene.render.resolution_y=64
scene.render.resolution_percentage=100
scene.render.pixel_aspect_x=1
scene.render.pixel_aspect_y=1
scene.render.film_transparent=True
scene.frame_set(1)
area.spaces.active.camera=cam
area.spaces.active.region_3d.view_perspective='CAMERA'
area.spaces.active.region_3d.view_camera_zoom=0
exports=[]
for direction in ('down','left','right','up'):
    target=bpy.data.objects[prefix+direction]
    for other in scene.objects:
        if other.type=='GREASEPENCIL':
            other.location=(0,0,0)
            other.hide_set(other!=target)
            other.select_set(other==target)
    bpy.context.view_layer.objects.active=target
    bpy.context.view_layer.update()
    dest=root / 'svg' / direction / 'idle.svg'
    dest.parent.mkdir(parents=True,exist_ok=True)
    with bpy.context.temp_override(window=window,area=area,region=region):
        result=bpy.ops.wm.grease_pencil_export_svg(filepath=str(dest),check_existing=False,selected_object_type='ACTIVE',frame_mode='ACTIVE',use_fill=True,stroke_sample=0.0,use_uniform_width=False,use_clip_camera=True)
    assert result=={'FINISHED'},result
    svg=ET.parse(dest).getroot()
    assert float(svg.attrib['width'].removesuffix('px'))==64 and float(svg.attrib['height'].removesuffix('px'))==64,svg.attrib
    paths=[el for el in svg.iter() if el.tag.endswith('}path')]
    images=[el for el in svg.iter() if el.tag.endswith('}image')]
    assert paths and not images
    exports.append({'direction':direction,'svg':str(dest.relative_to(root)), 'paths':len(paths), 'images':len(images)})
# Leave the down view selected in the editable scene, with no pose normalization.
for direction in ('down','left','right','up'):
    ob=bpy.data.objects[prefix+direction]
    ob.hide_set(direction!='down')
    ob.select_set(direction=='down')
bpy.context.view_layer.objects.active=bpy.data.objects[prefix+'down']
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(root/'source/avatar-1.blend'))
report={'blender':bpy.app.version_string,'nativeMcpTools':True,'scene':scene.name,'camera':{'type':cam.data.type,'orthoScale':64,'location':list(cam.location)},'render':[64,64], 'frame':1,'exports':exports,'geometrySource':'source/authoring.py','regionRecipe':'source/build_reference_vectors.py','reference':'reference/approved-concept-turnaround.png','construction':'source/construction/manifest.json','visibleGroupsOnly':True,'palette':'source/palette.json','master':'source/avatar-1.blend','approval':'pending','animation':'not-started'}
(root/'source/blender-environment.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
