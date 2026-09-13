"""Export existing v5 GP artwork using Blender's native SVG operator via MCP.

Supply AVATAR_SOURCE_DIR. Does not reconstruct geometry or normalize poses.
Export the currently declared subset of directions, then save the master.
"""
import bpy
import importlib.util
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('avatar_v5_contract', Path(AVATAR_SOURCE_DIR) / 'source_contract.py')
contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
data = contract.load(AVATAR_SOURCE_DIR)
root, source, prefix = data['root'], data['source'], contract.PREFIX
scene = bpy.data.scenes[prefix + 'Idle authoring']
contract.require(scene['geometry_sha256'] == data['geometrySha256'] and
                 scene['palette_sha256'] == data['paletteSha256'], 'Source inputs changed; explicitly rebuild before export')
window = bpy.context.window_manager.windows[0]; window.scene = scene
areas = [a for a in window.screen.areas if a.type == 'VIEW_3D']
contract.require(areas, 'Native SVG export requires an existing VIEW_3D area')
area = max(areas, key=lambda a: a.width * a.height)
region = next(r for r in area.regions if r.type == 'WINDOW')
cam = scene.camera
cam.location = (0, -1024, 0); cam.rotation_euler = (math.pi / 2, 0, 0)
cam.data.clip_end = 4096
cam.data.type = 'ORTHO'; cam.data.ortho_scale = contract.CANVAS; cam.data.shift_x = 0; cam.data.shift_y = 0
scene.render.resolution_x = contract.CANVAS; scene.render.resolution_y = contract.CANVAS; scene.render.resolution_percentage = 100
scene.render.pixel_aspect_x = 1; scene.render.pixel_aspect_y = 1
scene.render.film_transparent = True; scene.frame_set(1)
area.spaces.active.clip_end = 4096; area.spaces.active.camera = cam; area.spaces.active.region_3d.view_perspective = 'CAMERA'
area.spaces.active.region_3d.view_camera_zoom = 0
actual = {ob.get('direction') for ob in scene.objects if ob.type == 'GREASEPENCIL'}
contract.require(actual == set(data['directions']), 'Saved scene and declared source directions differ')
exports = []
for direction in data['directions']:
    target = scene.objects[prefix + direction]
    contract.require(all(abs(value) < 1e-7 for value in (*target.location, *target.rotation_euler)) and
                     all(abs(value - 1) < 1e-7 for value in target.scale),
                     direction + ': object transform changed; export will not hide it by resetting the pose')
    for other in scene.objects:
        other.select_set(other == target)
        if other.type == 'GREASEPENCIL':
            other.hide_set(other != target)
    bpy.context.view_layer.objects.active = target; bpy.context.view_layer.update()
    destination = root / 'svg' / direction / 'idle.svg'; destination.parent.mkdir(parents=True, exist_ok=True)
    with bpy.context.temp_override(window=window, area=area, region=region):
        result = bpy.ops.wm.grease_pencil_export_svg(filepath=str(destination), check_existing=False,
            selected_object_type='ACTIVE', frame_mode='ACTIVE', use_fill=True, stroke_sample=0.0,
            use_uniform_width=False, use_clip_camera=True)
    contract.require(result == {'FINISHED'}, 'Native SVG export did not finish')
    svg = ET.parse(destination).getroot()
    contract.require(float(svg.attrib['width'].removesuffix('px')) == contract.CANVAS and
                     float(svg.attrib['height'].removesuffix('px')) == contract.CANVAS, 'Native SVG viewport changed')
    paths = [el for el in svg.iter() if el.tag.endswith('}path')]
    images = [el for el in svg.iter() if el.tag.endswith('}image')]
    contract.require(paths and not images, 'SVG must contain native vector paths and no embedded bitmap')
    exports.append({'direction': direction, 'svg': destination.relative_to(root).as_posix(),
                    'paths': len(paths), 'images': len(images), 'sha256': contract.sha256(destination)})
initial = 'down' if 'down' in data['directions'] else data['directions'][0]
for direction in data['directions']:
    ob = scene.objects[prefix + direction]; ob.hide_set(direction != initial); ob.select_set(direction == initial)
bpy.context.view_layer.objects.active = scene.objects[prefix + initial]; bpy.context.view_layer.update()
master = source / 'avatar-1.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(master))
report = {'schemaVersion': 1, 'blender': bpy.app.version_string, 'nativeMcpTools': True,
          'scene': scene.name, 'camera': {'type': cam.data.type, 'orthoScale': contract.CANVAS, 'location': list(cam.location)},
          'render': [contract.CANVAS, contract.CANVAS], 'frame': 1, 'directions': data['directions'], 'exports': exports,
          'construction': 'source/idle-geometry.json', 'geometrySha256': data['geometrySha256'],
          'geometryProvenance': data['geometry'].get('provenance', {}),
          'palette': 'source/palette.json', 'paletteSha256': data['paletteSha256'],
          'reference': '../concept/' + data['approval']['artifact'], 'conceptSha256': data['approval']['sha256'],
          'constructionStudies': [{k: v for k, v in ref.items() if k != 'path'} for ref in data['references']],
          'master': 'source/avatar-1.blend', 'masterSha256': contract.sha256(master),
          'approval': 'internal-refinement', 'artisticQa': 'not-assessed', 'animation': 'not-started'}
(source / 'blender-environment.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
