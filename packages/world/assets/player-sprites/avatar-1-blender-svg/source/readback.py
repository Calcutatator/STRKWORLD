"""Read the saved/reopened live Blender drawing for independent verification."""
import bpy
import json
from pathlib import Path
root=Path(AVATAR_SOURCE_DIR).resolve().parent
views={}
for direction in ('down','left','right','up'):
    ob=bpy.data.objects['AV1SVG | '+direction]
    shapes=[]
    for layer in ob.data.layers:
        regions={}
        for st in layer.frames[0].drawing.strokes:
            material=ob.data.materials[st.material_index].name.removeprefix('AV1SVG | ')
            if st.fill_id not in regions:
                regions[st.fill_id]={'part':layer.name,'materialName':material,'fillId':st.fill_id,'hideStroke':True,'cyclic':True,'contours':[]}
            entry=regions[st.fill_id]
            assert entry['materialName']==material
            entry['hideStroke']=entry['hideStroke'] and st.hide_stroke
            entry['cyclic']=entry['cyclic'] and st.cyclic
            entry['contours'].append([[p.position.x+32,32-p.position.z] for p in st.points])
        shapes.extend(regions.values())
    views[direction]=shapes
(root/'source/blender-readback.json').write_text(json.dumps({'blender':bpy.app.version_string,'reopenedMaster':bpy.data.filepath,'views':views},separators=(',',':'))+'\n')
print(json.dumps({'readback':{d:len(s) for d,s in views.items()}}))
