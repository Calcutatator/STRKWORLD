"""Build editable v5 native Grease Pencil fills. Execute only via Blender MCP.

Supply AVATAR_SOURCE_DIR. Detailed input vector regions retain their declared
construction provenance; packed references stay outside the export camera.
"""
import bpy
import importlib.util
import json
import math
from pathlib import Path

spec = importlib.util.spec_from_file_location('avatar_v5_contract', Path(AVATAR_SOURCE_DIR) / 'source_contract.py')
contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
data = contract.load(AVATAR_SOURCE_DIR)
root, source, prefix = data['root'], data['source'], contract.PREFIX
window = bpy.context.window_manager.windows[0]
old_scene = bpy.data.scenes.get(prefix + 'Idle authoring')
if old_scene:
    for win in bpy.context.window_manager.windows:
        if win.scene == old_scene:
            win.scene = next((s for s in bpy.data.scenes if s != old_scene), None) or bpy.data.scenes.new('Art workspace')
    bpy.data.scenes.remove(old_scene)
for ob in list(bpy.data.objects):
    if ob.name.startswith(prefix):
        contract.require(not ob.users_scene, 'A v5 object is shared with another scene; preserve it and resolve the ownership first')
        bpy.data.objects.remove(ob, do_unlink=True)
for collection in (bpy.data.grease_pencils, bpy.data.materials, bpy.data.cameras, bpy.data.images):
    for block in list(collection):
        if block.name.startswith(prefix) and block.users == 0:
            collection.remove(block)
scene = bpy.data.scenes.new(prefix + 'Idle authoring'); window.scene = scene
scene.render.resolution_x = contract.CANVAS; scene.render.resolution_y = contract.CANVAS; scene.render.resolution_percentage = 100
scene.render.pixel_aspect_x = 1; scene.render.pixel_aspect_y = 1
scene.render.film_transparent = True; scene.render.fps = 8; scene.frame_set(1)
scene['concept_sha256'] = data['approval']['sha256']
scene['concept_approval'] = 'James: Yes good concept move forward'
scene['sprite_approval'] = 'Internal refinement; no user sprite approval'
scene['animation_status'] = 'Not started; separate idle approval required'
scene['geometry_sha256'] = data['geometrySha256']; scene['palette_sha256'] = data['paletteSha256']
scene['geometry_provenance_json'] = json.dumps(data['geometry'].get('provenance', {}), sort_keys=True)
scene['directions_json'] = json.dumps(data['directions'])
scene['source_canvas'] = contract.CANVAS
scene['logical_cell'] = 64
scene['png_density'] = 4
scene['rendering_style'] = 'Detailed antialiased vector illustration; no low-resolution pixel-grid construction'
camdata = bpy.data.cameras.new(prefix + 'Orthographic camera')
cam = bpy.data.objects.new(prefix + 'Orthographic camera', camdata); scene.collection.objects.link(cam)
cam.location = (0, -1024, 0); cam.rotation_euler = (math.pi / 2, 0, 0)
camdata.type = 'ORTHO'; camdata.ortho_scale = contract.CANVAS; camdata.clip_end = 4096; scene.camera = cam

def pack_reference(path, label, digest, position, approval):
    # Reload the on-disk bytes so editing a study at the same path cannot leave
    # an older cached image packed into the new source.
    image = bpy.data.images.load(str(path), check_existing=False)
    image.name = prefix + label; image.pack()
    ref = bpy.data.objects.new(prefix + label, None)
    ref.empty_display_type = 'IMAGE'; ref.data = image; ref.empty_display_size = 768
    ref.location = position; ref.rotation_euler = (math.pi / 2, 0, 0); ref.hide_render = True
    ref['sha256'] = digest; ref['approval_scope'] = approval
    scene.collection.objects.link(ref)

pack_reference(data['conceptPath'], 'Approved concept reference', data['approval']['sha256'],
               (800, 1, 0), 'Approved concept identity; not sprite or animation approval')
for index, reference in enumerate(data['references']):
    pack_reference(reference['path'], 'ImageGen construction study NOT approved concept: ' + reference['path'].stem,
                   reference['sha256'], (800 + 880 * (index + 1), 1, 0), reference['approval'])
materials, indexes = [], {}
for index, entry in enumerate(data['palette']['colors']):
    material = bpy.data.materials.new(prefix + entry['name']); bpy.data.materials.create_gpencil_data(material)
    material.grease_pencil.show_stroke = False; material.grease_pencil.show_fill = True
    material.grease_pencil.fill_color = contract.material_rgba(entry['hex'])
    indexes[entry['name']] = index; materials.append(material)
initial = 'down' if 'down' in data['directions'] else data['directions'][0]
for direction in data['directions']:
    gp = bpy.data.grease_pencils.new(prefix + direction); gp.stroke_depth_order = '2D'
    ob = bpy.data.objects.new(prefix + direction, gp); scene.collection.objects.link(ob)
    ob['direction'] = direction; ob['pose'] = 'idle'; ob['concept_sha256'] = data['approval']['sha256']
    for material in materials:
        gp.materials.append(material)
    for index, shape in enumerate(data['geometry']['views'][direction]):
        layer = gp.layers.new(f"{index:03d}_{shape['part']}", set_active=True); layer.use_lights = False
        drawing = layer.frames.new(1).drawing
        drawing.add_strokes([len(contour) for contour in shape['contours']])
        for stroke, contour in zip(drawing.strokes, shape['contours']):
            stroke.cyclic = True
            stroke.material_index = indexes[shape['color']]; stroke.fill_opacity = 1
            stroke.fill_color = (0, 0, 0, 0); stroke.fill_id = 1; stroke.hide_stroke = True
            for point, (x, y) in zip(stroke.points, contour):
                point.position = (x - contract.CENTER, 0, contract.CENTER - y); point.radius = 0.01; point.opacity = 1
        drawing.tag_positions_changed()
    ob.hide_set(direction != initial); ob.select_set(direction == initial)
    if direction == initial:
        bpy.context.view_layer.objects.active = ob
areas = [a for a in window.screen.areas if a.type == 'VIEW_3D']
contract.require(areas, 'Native SVG export requires an existing VIEW_3D area')
area = max(areas, key=lambda a: a.width * a.height)
area.spaces.active.clip_end = 4096; area.spaces.active.camera = cam; area.spaces.active.region_3d.view_perspective = 'CAMERA'
area.spaces.active.region_3d.view_camera_zoom = 0; area.spaces.active.overlay.show_overlays = False
area.spaces.active.shading.type = 'MATERIAL'; bpy.context.view_layer.update()
print(json.dumps({'scene': scene.name, 'directions': data['directions'],
                  'shapes': {d: len(data['geometry']['views'][d]) for d in data['directions']},
                  'conceptSha256': data['approval']['sha256'], 'constructionStudiesPacked': len(data['references']),
                  'status': 'internal-refinement', 'artisticQa': 'not-assessed'}))
