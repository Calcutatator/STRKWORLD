"""Read live v6 GP geometry/materials after the coordinator reopens the master.

Run via native Blender MCP with AVATAR_SOURCE_DIR. Reading does not rebuild or
save anything. A readback cannot itself prove that the caller reopened Blender.
"""
import bpy
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('avatar_v6_contract', Path(AVATAR_SOURCE_DIR) / 'source_contract.py')
contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
data = contract.load(AVATAR_SOURCE_DIR, require_internal=False); source = data['source']; prefix = contract.PREFIX
master = (source / 'avatar-1.blend').resolve()
contract.require(Path(bpy.data.filepath).resolve() == master, 'Open this revision saved master before readback')
contract.require(not bpy.data.is_dirty, 'Readback requires saved, unmodified Blender data')
scene = bpy.data.scenes[prefix + 'Idle authoring']
views, transforms, references = {}, {}, []
for direction in data['directions']:
    ob = scene.objects[prefix + direction]
    transforms[direction] = {'location': list(ob.location), 'rotationEuler': list(ob.rotation_euler),
                             'scale': list(ob.scale), 'strokeDepthOrder': ob.data.stroke_depth_order}
    shapes = []
    for layer in ob.data.layers:
        contract.require(len(layer.frames) == 1 and layer.frames[0].frame_number == 1,
                         'Only the declared idle frame belongs in the current source')
        regions = {}
        for stroke in layer.frames[0].drawing.strokes:
            material = ob.data.materials[stroke.material_index]
            material_name = material.name.removeprefix(prefix)
            if stroke.fill_id not in regions:
                regions[stroke.fill_id] = {'part': layer.name, 'materialName': material_name,
                    'materialLinearRgba': list(material.grease_pencil.fill_color),
                    'materialShowFill': material.grease_pencil.show_fill,
                    'materialShowStroke': material.grease_pencil.show_stroke,
                    'fillId': stroke.fill_id, 'hideStroke': True, 'cyclic': True,
                    'fillOpacity': stroke.fill_opacity, 'contours': []}
            region = regions[stroke.fill_id]
            contract.require(region['materialName'] == material_name and region['fillOpacity'] == stroke.fill_opacity,
                             'Mixed material or opacity inside one region')
            region['hideStroke'] = region['hideStroke'] and stroke.hide_stroke
            region['cyclic'] = region['cyclic'] and stroke.cyclic
            contract.require(all(abs(point.position.y) < 1e-7 for point in stroke.points), 'Unexpected depth in flat geometry')
            region['contours'].append([[point.position.x + contract.CENTER, contract.CENTER - point.position.z] for point in stroke.points])
        shapes.extend(regions.values())
    views[direction] = shapes
for ob in scene.objects:
    if ob.type == 'EMPTY' and ob.empty_display_type == 'IMAGE' and ob.data:
        packed = ob.data.packed_file
        references.append({'name': ob.name, 'sha256': ob.get('sha256'), 'approvalScope': ob.get('approval_scope'),
            'packed': packed is not None,
            'packedBytesSha256': __import__('hashlib').sha256(bytes(packed.data)).hexdigest() if packed else None})
report = {'schemaVersion': 1, 'blender': bpy.app.version_string, 'reopenedMaster': bpy.data.filepath,
          'masterSha256AtReadback': contract.sha256(master), 'liveDataIsDirty': bpy.data.is_dirty,
          'geometrySha256': scene['geometry_sha256'], 'paletteSha256': scene['palette_sha256'],
          'conceptSha256': scene['concept_sha256'], 'styleSha256': scene['style_sha256'],
          'pixelContract': {'sourceCanvas': scene['source_canvas'], 'logicalCell': scene['logical_cell'],
                            'pngDensity': scene['png_density']},
          'geometryProvenance': json.loads(scene['geometry_provenance_json']),
          'views': views, 'transforms': transforms, 'packedReferences': references,
          'scope': 'Read actual live data after a caller-managed reload; no independent reload attestation or artistic assessment'}
(source / 'blender-readback.json').write_text(json.dumps(report, separators=(',', ':')) + '\n')
print(json.dumps({'readback': {d: len(s) for d, s in views.items()}, 'packedReferences': len(references),
                  'masterSha256': report['masterSha256AtReadback'], 'artisticQa': 'not-assessed'}))
